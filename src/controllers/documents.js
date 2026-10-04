const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../config/db');
const pdfProcessor = require('../services/pdfProcessor');
const ai = require('../services/ai');
const vectorStore = require('../services/vectorStore');

// Configure multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '..', '..', 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

// Multer upload middleware configuration
const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    const filetypes = /pdf/i;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Only PDF files are allowed!'));
  },
  limits: { fileSize: 50 * 1024 * 1024 } // 50 MB limit
}).single('file');

/**
 * Concurrency helper for rate-limited async batch processing.
 */
async function mapConcurrent(items, concurrency, fn) {
  const results = [];
  const executing = new Set();
  
  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    results.push(p);
    executing.add(p);
    
    const clean = () => executing.delete(p);
    p.then(clean).catch(clean);
    
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  
  return Promise.all(results);
}

// Asynchronous background processing pipeline
async function runProcessingPipeline(documentId, filePath) {
  try {
    console.log(`[Pipeline] Starting background processing for document ID: ${documentId}, file: ${filePath}`);
    
    // 1. PyMuPDF Extraction + Table Detection + Outline/TOC + Cleaning + Semantic Chunking
    const extractedData = await pdfProcessor.extractAndChunkPdf(filePath);
    const rawChunks = extractedData.chunks || [];
    
    if (rawChunks.length === 0) {
      throw new Error('No readable text or table content could be extracted from this PDF.');
    }
    
    console.log(`[Pipeline] Generated ${rawChunks.length} semantic chunks (${extractedData.tables_detected || 0} tables, ${extractedData.pages_count || 0} pages).`);
    
    const allChunks = rawChunks.map((c, idx) => ({
      chunk_index: c.chunk_index !== undefined ? c.chunk_index : idx,
      content: c.content,
      pageNumber: c.page || 1,
      heading: c.heading || 'General Overview',
      section_path: c.section_path || c.heading || 'General Overview',
      content_type: c.content_type || 'text',
      summary_hint: c.summary_hint || '',
      metadata: { 
        page: c.page || 1, 
        heading: c.heading || 'General Overview',
        section_path: c.section_path || c.heading || 'General Overview',
        content_type: c.content_type || 'text'
      }
    }));

    // Check if the document was cancelled/deleted during extraction
    const docCheck = await db.query('SELECT id, filename FROM documents WHERE id = $1', [documentId]);
    if (docCheck.rows.length === 0) {
      console.log(`[Pipeline] Document ID ${documentId} was cancelled. Aborting background processing.`);
      return;
    }
    const docFilename = docCheck.rows[0].filename;

    // 2. Batch generate embeddings with concurrency control
    const batchSize = 40;
    const batches = [];
    for (let i = 0; i < allChunks.length; i += batchSize) {
      batches.push(allChunks.slice(i, i + batchSize));
    }
    
    console.log(`[Pipeline] Generating embeddings for ${batches.length} batches with concurrency control...`);
    
    await mapConcurrent(batches, 3, async (batch) => {
      // Contextualize text for embedding with Document and Section hierarchy
      const textsToEmbed = batch.map(c => `[Document: ${docFilename}] [Section: ${c.section_path || c.heading}] ${c.content}`);
      const embeddings = await ai.getEmbeddings(textsToEmbed);
      
      for (let j = 0; j < batch.length; j++) {
        batch[j].embedding = embeddings[j];
      }
    });
    
    // Check if document cancelled during embedding
    const docCheck2 = await db.query('SELECT id FROM documents WHERE id = $1', [documentId]);
    if (docCheck2.rows.length === 0) {
      console.log(`[Pipeline] Document ID ${documentId} was cancelled during embedding. Aborting.`);
      return;
    }
    
    // 3. Save chunks, tsvector keyword index, and embeddings to pgvector / PostgreSQL
    await vectorStore.saveChunks(documentId, allChunks);

    // 4. Generate and save executive document summary into PostgreSQL
    try {
      const summaryResult = await ai.generateDocumentSummary(allChunks, docFilename);
      await vectorStore.saveDocumentSummary(documentId, summaryResult.summary, summaryResult.keyTakeaways);
      console.log(`[Pipeline] Document summary generated and saved for ID: ${documentId}`);
    } catch (sumErr) {
      console.warn(`[Pipeline] Document summary generation warning for ID ${documentId}:`, sumErr.message);
    }
    
    // 5. Update document status to processed
    await db.query(
      'UPDATE documents SET status = $1 WHERE id = $2',
      ['processed', documentId]
    );
    console.log(`[Pipeline] Document processing completed successfully for ID: ${documentId}`);
    
  } catch (error) {
    const docExists = await db.query('SELECT id FROM documents WHERE id = $1', [documentId]);
    if (docExists.rows.length === 0) {
      console.log(`[Pipeline] Document ID ${documentId} was deleted/cancelled. Pipeline exited cleanly.`);
      return;
    }
    
    console.error(`[Pipeline] Failed to process document ID: ${documentId}. Error:`, error);
    await db.query(
      'UPDATE documents SET status = $1 WHERE id = $2',
      ['failed', documentId]
    );
  }
}

// Controller to upload PDF and start background processing
function uploadDocument(req, res) {
  upload(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload a PDF file' });
    }
    
    const userId = req.user.id;
    const filename = req.file.originalname;
    const filePath = req.file.path;
    
    try {
      const insertResult = await db.query(
        'INSERT INTO documents (user_id, filename, file_path, status) VALUES ($1, $2, $3, $4) RETURNING *',
        [userId, filename, filePath, 'processing']
      );
      
      const document = insertResult.rows[0];
      
      // Trigger background processing asynchronously
      runProcessingPipeline(document.id, filePath);
      
      return res.status(202).json({
        message: 'Document uploaded and is currently processing in the background.',
        document
      });
      
    } catch (error) {
      console.error('Error inserting document record:', error);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      return res.status(500).json({ error: 'Database error occurred during document upload' });
    }
  });
}

// Controller to list all user documents
async function listDocuments(req, res, next) {
  const userId = req.user.id;
  try {
    const result = await db.query(
      'SELECT id, filename, status, created_at FROM documents WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    return res.json(result.rows);
  } catch (error) {
    next(error);
  }
}

// Controller to get details of a specific document (including executive summary if ready)
async function getDocument(req, res, next) {
  const userId = req.user.id;
  const docId = req.params.id;
  
  try {
    const result = await db.query(
      `SELECT d.id, d.filename, d.status, d.created_at, ds.summary, ds.key_takeaways 
       FROM documents d
       LEFT JOIN document_summaries ds ON d.id = ds.document_id
       WHERE d.id = $1 AND d.user_id = $2`,
      [docId, userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found or unauthorized' });
    }
    
    return res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
}

// Controller to delete a document and clean up local file
async function deleteDocument(req, res, next) {
  const userId = req.user.id;
  const docId = req.params.id;
  
  try {
    const selectResult = await db.query(
      'SELECT id, file_path FROM documents WHERE id = $1 AND user_id = $2',
      [docId, userId]
    );
    
    if (selectResult.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found or unauthorized' });
    }
    
    const doc = selectResult.rows[0];
    const filePath = doc.file_path;
    
    await db.query('DELETE FROM documents WHERE id = $1', [docId]);
    
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        console.error(`Failed to delete file from disk: ${filePath}. Error: ${err.message}`);
      }
    }
    
    return res.json({ message: 'Document deleted successfully' });
  } catch (error) {
    next(error);
  }
}

// Helper to enrich raw concept graph with hierarchy, summaries, and source evidence
function enrichConceptGraph(graphData, chunks = [], filename = '') {
  if (!graphData || !graphData.nodes || graphData.nodes.length === 0) {
    return graphData;
  }

  const nodes = graphData.nodes;
  const links = graphData.links || [];

  // Calculate degrees to find root concept
  const degreeMap = {};
  nodes.forEach(n => { degreeMap[n.id] = 0; });
  links.forEach(l => {
    const sId = typeof l.source === 'object' ? l.source.id : l.source;
    const tId = typeof l.target === 'object' ? l.target.id : l.target;
    degreeMap[sId] = (degreeMap[sId] || 0) + 1;
    degreeMap[tId] = (degreeMap[tId] || 0) + 1;
  });

  // Pick root candidate: node matching filename keywords or highest degree
  const cleanFilename = filename.replace(/\.pdf$/i, '').toLowerCase();
  let rootId = nodes[0].id;
  const nameMatch = nodes.find(n => cleanFilename.includes(n.id.toLowerCase()) || n.id.toLowerCase().includes('database') || n.id.toLowerCase().includes('operating'));
  if (nameMatch) {
    rootId = nameMatch.id;
  } else {
    let maxDeg = -1;
    for (const n of nodes) {
      if ((degreeMap[n.id] || 0) > maxDeg) {
        maxDeg = degreeMap[n.id];
        rootId = n.id;
      }
    }
  }

  // Build undirected adjacency for BFS spanning tree
  const adj = {};
  nodes.forEach(n => { adj[n.id] = []; });
  links.forEach(l => {
    const sId = typeof l.source === 'object' ? l.source.id : l.source;
    const tId = typeof l.target === 'object' ? l.target.id : l.target;
    if (adj[sId]) adj[sId].push({ target: tId, relationship: l.relationship });
    if (adj[tId]) adj[tId].push({ target: sId, relationship: l.relationship });
  });

  // BFS to determine hierarchy levels & tree parent-child
  const visited = new Set([rootId]);
  const levels = { [rootId]: 0 };
  const parentMap = { [rootId]: null };
  const treeChildren = {};
  nodes.forEach(n => { treeChildren[n.id] = []; });

  const queue = [rootId];
  while (queue.length > 0) {
    const curr = queue.shift();
    const currLevel = levels[curr];

    const neighbors = adj[curr] || [];
    for (const edge of neighbors) {
      if (!visited.has(edge.target)) {
        visited.add(edge.target);
        levels[edge.target] = currLevel + 1;
        parentMap[edge.target] = curr;
        treeChildren[curr].push(edge.target);
        queue.push(edge.target);
      }
    }
  }

  // Attach any disconnected nodes to root
  for (const n of nodes) {
    if (!visited.has(n.id)) {
      visited.add(n.id);
      levels[n.id] = 1;
      parentMap[n.id] = rootId;
      treeChildren[rootId].push(n.id);
    }
  }

  // Enrich each node with title, level, summary, and source references
  const enrichedNodes = nodes.map(n => {
    const title = n.id.replace(/_/g, ' ');
    const rawLevel = levels[n.id] !== undefined ? levels[n.id] : 2;
    const level = Math.min(rawLevel, 3);

    // Search chunks for source references
    const matchingChunks = [];
    const searchTerms = [n.id.toLowerCase(), title.toLowerCase()];
    
    if (chunks && chunks.length > 0) {
      for (const chunk of chunks) {
        const lower = (chunk.content || '').toLowerCase();
        if (searchTerms.some(term => lower.includes(term))) {
          matchingChunks.push(chunk);
          if (matchingChunks.length >= 4) break;
        }
      }
    }

    const sourceReferences = matchingChunks.map(c => {
      const sentences = c.content.split(/[.\n]+/);
      const matchSentence = sentences.find(s => searchTerms.some(t => s.toLowerCase().includes(t))) || sentences[0] || '';
      return {
        document: filename,
        page: c.page_number,
        heading: c.heading || 'General Topic',
        snippet: matchSentence.trim() ? matchSentence.trim() + '.' : c.content.slice(0, 220)
      };
    });

    let summary = n.summary;
    if (!summary) {
      if (sourceReferences.length > 0 && sourceReferences[0].snippet) {
        summary = sourceReferences[0].snippet;
      } else {
        summary = `${title} is a core conceptual entity identified in ${filename}.`;
      }
    }

    const related = (adj[n.id] || []).map(r => ({
      targetId: r.target,
      targetTitle: r.target.replace(/_/g, ' '),
      relationship: r.relationship || 'relates to'
    }));

    return {
      id: n.id,
      title,
      group: n.group || (level === 0 ? 'Root Concept' : level === 1 ? 'Major Topic' : 'Subtopic'),
      val: level === 0 ? 24 : level === 1 ? 18 : level === 2 ? 14 : 10,
      level,
      parent: parentMap[n.id] || null,
      children: treeChildren[n.id] || [],
      summary,
      sourceReferences,
      related
    };
  });

  return {
    rootId,
    nodes: enrichedNodes,
    links: links.map(l => ({
      source: typeof l.source === 'object' ? l.source.id : l.source,
      target: typeof l.target === 'object' ? l.target.id : l.target,
      relationship: l.relationship || 'relates to'
    }))
  };
}

// Controller to get or auto-generate concept graph for a document
async function getConceptGraph(req, res, next) {
  const userId = req.user.id;
  const docId = req.params.id;

  try {
    const docRes = await db.query(
      'SELECT id, filename, status, graph_data FROM documents WHERE id = $1 AND user_id = $2',
      [docId, userId]
    );

    if (docRes.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found or unauthorized' });
    }

    const doc = docRes.rows[0];
    if (doc.status !== 'processed') {
      return res.status(400).json({ error: `Cannot generate concept graph for document in "${doc.status}" state.` });
    }

    const chunksRes = await db.query(
      'SELECT page_number, content FROM document_chunks WHERE document_id = $1 ORDER BY page_number ASC',
      [docId]
    );

    let rawGraph = doc.graph_data;
    if (!rawGraph) {
      if (chunksRes.rows.length === 0) {
        return res.status(400).json({ error: 'No extracted text chunks found for this document.' });
      }
      rawGraph = await ai.generateConceptGraph(chunksRes.rows, doc.filename);
      await db.query(
        'UPDATE documents SET graph_data = $1 WHERE id = $2',
        [JSON.stringify(rawGraph), docId]
      );
    }

    const enriched = enrichConceptGraph(rawGraph, chunksRes.rows, doc.filename);
    return res.json({ graph: enriched, cached: !!doc.graph_data });

  } catch (error) {
    console.error('Error fetching concept graph:', error);
    next(error);
  }
}

// Controller to force regenerate concept graph
async function regenerateConceptGraph(req, res, next) {
  const userId = req.user.id;
  const docId = req.params.id;

  try {
    const docRes = await db.query(
      'SELECT id, filename, status FROM documents WHERE id = $1 AND user_id = $2',
      [docId, userId]
    );

    if (docRes.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found or unauthorized' });
    }

    const doc = docRes.rows[0];
    if (doc.status !== 'processed') {
      return res.status(400).json({ error: `Cannot regenerate concept graph for document in "${doc.status}" state.` });
    }

    const chunksRes = await db.query(
      'SELECT page_number, content FROM document_chunks WHERE document_id = $1 ORDER BY page_number ASC',
      [docId]
    );

    const graphData = await ai.generateConceptGraph(chunksRes.rows, doc.filename);

    await db.query(
      'UPDATE documents SET graph_data = $1 WHERE id = $2',
      [JSON.stringify(graphData), docId]
    );

    return res.json({ graph: graphData, regenerated: true });

  } catch (error) {
    console.error('Error regenerating concept graph:', error);
    next(error);
  }
}

module.exports = {
  uploadDocument,
  listDocuments,
  getDocument,
  deleteDocument,
  getConceptGraph,
  regenerateConceptGraph
};
