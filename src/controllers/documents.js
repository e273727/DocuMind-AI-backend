const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../config/db');
const pdfProcessor = require('../services/pdfProcessor');
const ai = require('../services/ai');
const vectorStore = require('../services/vectorStore');

const os = require('os');

// Configure multer storage (use os.tmpdir() on Vercel / serverless where filesystem is read-only)
const getUploadDir = () => {
  if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
    return path.join(os.tmpdir(), 'documind-uploads');
  }
  return path.join(__dirname, '..', '..', 'uploads');
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = getUploadDir();
    if (!fs.existsSync(uploadDir)) {
      try {
        fs.mkdirSync(uploadDir, { recursive: true });
      } catch (e) {
        // Fallback directly to tmpdir if custom folder fails
        return cb(null, os.tmpdir());
      }
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
    return { rootId: null, nodes: [], links: [] };
  }

  const rawNodes = graphData.nodes;
  const rawLinks = graphData.links || [];

  // 1. Build canonical ID lookup to handle minor LLM naming/casing variations
  const canonicalMap = new Map();
  const normalizeKey = (str) => String(str || '').trim().toLowerCase().replace(/[_\s-]+/g, ' ');

  rawNodes.forEach(n => {
    if (!n || !n.id) return;
    const cleanId = String(n.id).trim();
    canonicalMap.set(normalizeKey(cleanId), cleanId);
    canonicalMap.set(cleanId.toLowerCase(), cleanId);
    canonicalMap.set(cleanId, cleanId);
  });

  // 2. Resolve and validate links
  const validLinks = [];
  const linkDedup = new Set();

  rawLinks.forEach(l => {
    const rawSource = typeof l.source === 'object' ? l.source.id : l.source;
    const rawTarget = typeof l.target === 'object' ? l.target.id : l.target;
    if (!rawSource || !rawTarget) return;

    const sourceId = canonicalMap.get(normalizeKey(rawSource)) || canonicalMap.get(rawSource);
    const targetId = canonicalMap.get(normalizeKey(rawTarget)) || canonicalMap.get(rawTarget);

    if (sourceId && targetId && sourceId !== targetId) {
      const rel = (l.relationship || 'relates to').trim().replace(/_/g, ' ');
      const key = `${sourceId}:::${targetId}`;
      if (!linkDedup.has(key)) {
        linkDedup.add(key);
        validLinks.push({
          source: sourceId,
          target: targetId,
          relationship: rel
        });
      }
    }
  });

  // 3. Compute connectivity degrees (in, out, total)
  const inDegree = {};
  const outDegree = {};
  const totalDegree = {};
  rawNodes.forEach(n => {
    inDegree[n.id] = 0;
    outDegree[n.id] = 0;
    totalDegree[n.id] = 0;
  });

  validLinks.forEach(l => {
    outDegree[l.source] = (outDegree[l.source] || 0) + 1;
    inDegree[l.target] = (inDegree[l.target] || 0) + 1;
    totalDegree[l.source] = (totalDegree[l.source] || 0) + 1;
    totalDegree[l.target] = (totalDegree[l.target] || 0) + 1;
  });

  // 4. Determine Root Concept
  // Priority: (a) explicit is_root flag, (b) name matching filename keywords, (c) highest total degree
  const cleanFilename = filename.replace(/\.pdf$/i, '').toLowerCase();
  let rootId = null;

  const explicitRoot = rawNodes.find(n => n.is_root);
  if (explicitRoot) {
    rootId = explicitRoot.id;
  } else {
    const nameMatch = rawNodes.find(n => cleanFilename.includes(n.id.toLowerCase()) || n.id.toLowerCase().includes(cleanFilename));
    if (nameMatch) {
      rootId = nameMatch.id;
    } else {
      let maxDeg = -1;
      rawNodes.forEach(n => {
        if ((totalDegree[n.id] || 0) > maxDeg) {
          maxDeg = totalDegree[n.id];
          rootId = n.id;
        }
      });
    }
  }
  if (!rootId && rawNodes.length > 0) {
    rootId = rawNodes[0].id;
  }

  // 5. Adjacency lists for graph traversal and rich relation tracking
  const adj = {};
  const detailedAdj = {};
  rawNodes.forEach(n => {
    adj[n.id] = [];
    detailedAdj[n.id] = [];
  });

  validLinks.forEach(l => {
    adj[l.source].push({ target: l.target, relationship: l.relationship });
    adj[l.target].push({ target: l.source, relationship: l.relationship });

    detailedAdj[l.source].push({
      targetId: l.target,
      targetTitle: l.target.replace(/_/g, ' '),
      relationship: l.relationship,
      direction: 'outgoing'
    });
    detailedAdj[l.target].push({
      targetId: l.source,
      targetTitle: l.source.replace(/_/g, ' '),
      relationship: l.relationship,
      direction: 'incoming'
    });
  });

  // 6. BFS to build primary mind-map hierarchy tree
  const visited = new Set([rootId]);
  const levels = { [rootId]: 0 };
  const parentMap = { [rootId]: null };
  const treeChildren = {};
  rawNodes.forEach(n => { treeChildren[n.id] = []; });

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

  // 7. Ensure no orphans: link any disconnected nodes to root or closest category
  for (const n of rawNodes) {
    if (!visited.has(n.id)) {
      visited.add(n.id);
      levels[n.id] = 1;
      parentMap[n.id] = rootId;
      treeChildren[rootId].push(n.id);

      // Add synthetic relationship link
      const fallbackRel = 'includes';
      validLinks.push({
        source: rootId,
        target: n.id,
        relationship: fallbackRel
      });
      detailedAdj[rootId].push({
        targetId: n.id,
        targetTitle: n.id.replace(/_/g, ' '),
        relationship: fallbackRel,
        direction: 'outgoing'
      });
      detailedAdj[n.id].push({
        targetId: rootId,
        targetTitle: rootId.replace(/_/g, ' '),
        relationship: fallbackRel,
        direction: 'incoming'
      });
    }
  }

  // 7b. Tree Balancing: If root has > 5 direct children, group them by category into a balanced 2-3 tier hierarchy
  if ((treeChildren[rootId] || []).length > 5) {
    const rawDirectChildren = [...treeChildren[rootId]];
    const groupMap = new Map();

    rawDirectChildren.forEach(childId => {
      const childNode = rawNodes.find(n => n.id === childId);
      const grp = (childNode?.group || 'Core Concepts').trim();
      if (!groupMap.has(grp)) groupMap.set(grp, []);
      groupMap.get(grp).push(childId);
    });

    if (groupMap.size >= 2) {
      const newRootChildren = [];

      groupMap.forEach((members, grp) => {
        if (members.length <= 1) {
          newRootChildren.push(members[0]);
          return;
        }

        const normalize = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        let pillarId = members.find(mId => {
          const nm = normalize(mId);
          const ng = normalize(grp);
          return nm === ng || nm.includes(ng) || ng.includes(nm);
        });

        if (!pillarId) {
          let maxDeg = -1;
          members.forEach(mId => {
            if ((totalDegree[mId] || 0) > maxDeg) {
              maxDeg = totalDegree[mId];
              pillarId = mId;
            }
          });
        }

        if (pillarId) {
          newRootChildren.push(pillarId);
          levels[pillarId] = 1;
          parentMap[pillarId] = rootId;

          const subMembers = members.filter(m => m !== pillarId);
          treeChildren[pillarId] = Array.from(new Set([...(treeChildren[pillarId] || []), ...subMembers]));
          subMembers.forEach(m => {
            levels[m] = Math.max(levels[m] || 2, 2);
            parentMap[m] = pillarId;
            const existingRel = validLinks.find(l => (l.source === pillarId && l.target === m) || (l.source === m && l.target === pillarId));
            if (!existingRel) {
              validLinks.push({
                source: pillarId,
                target: m,
                relationship: 'contains'
              });
            }
          });
        } else {
          newRootChildren.push(...members);
        }
      });

      treeChildren[rootId] = newRootChildren;
    }
  }

  // 8. Enrich node metadata
  const enrichedNodes = rawNodes.map(n => {
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
      related: detailedAdj[n.id] || []
    };
  });

  return {
    rootId,
    nodes: enrichedNodes,
    links: validLinks
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

    const enriched = enrichConceptGraph(graphData, chunksRes.rows, doc.filename);
    return res.json({ graph: enriched, regenerated: true });

  } catch (error) {
    console.error('Error regenerating concept graph:', error);
    next(error);
  }
}

// Controller to stream raw PDF file for in-browser viewing
async function getDocumentPdf(req, res, next) {
  const userId = req.user.id;
  const docId = req.params.id;

  try {
    const docRes = await db.query(
      'SELECT file_path, filename FROM documents WHERE id = $1 AND user_id = $2',
      [docId, userId]
    );

    if (docRes.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found or unauthorized' });
    }

    const { file_path, filename } = docRes.rows[0];
    if (!file_path || !fs.existsSync(file_path)) {
      return res.status(404).json({ error: 'PDF file not found on disk' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
    fs.createReadStream(file_path).pipe(res);
  } catch (error) {
    console.error('Error streaming PDF:', error);
    next(error);
  }
}

module.exports = {
  uploadDocument,
  listDocuments,
  getDocument,
  getDocumentPdf,
  deleteDocument,
  getConceptGraph,
  regenerateConceptGraph
};
