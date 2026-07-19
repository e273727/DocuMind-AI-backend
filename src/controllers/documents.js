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
    // Only accept PDFs
    const filetypes = /pdf/i;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Only PDF files are allowed!'));
  },
  limits: { fileSize: 25 * 1024 * 1024 } // 25 MB limit
}).single('file');

// Asynchronous background processing pipeline
async function runProcessingPipeline(documentId, filePath) {
  try {
    console.log(`Starting background processing for document ID: ${documentId}, file: ${filePath}`);
    
    // 1. Extract text page-by-page
    const pages = await pdfProcessor.extractTextFromPdf(filePath);
    console.log(`Extracted ${pages.length} pages from PDF`);
    
    // 2. Chunk text and retain page numbers
    const allChunks = [];
    for (const page of pages) {
      const pageText = page.text;
      if (!pageText || pageText.trim() === '') continue;
      
      const textChunks = pdfProcessor.chunkText(pageText, 1000, 200);
      for (const chunkText of textChunks) {
        allChunks.push({
          content: chunkText,
          pageNumber: page.page
        });
      }
    }
    
    if (allChunks.length === 0) {
      throw new Error('No text content could be extracted from this PDF');
    }
    
    console.log(`Generated ${allChunks.length} text chunks`);
    
    // Check if the document was cancelled/deleted during extraction
    const docCheck = await db.query('SELECT id FROM documents WHERE id = $1', [documentId]);
    if (docCheck.rows.length === 0) {
      console.log(`Document ID ${documentId} was cancelled. Aborting background processing.`);
      return;
    }
    
    // 3. Batch generate embeddings in parallel using Promise.all
    // We segment into batches of 100 chunks for efficiency
    const batchSize = 100;
    const batches = [];
    for (let i = 0; i < allChunks.length; i += batchSize) {
      batches.push(allChunks.slice(i, i + batchSize));
    }
    
    console.log(`Generating embeddings for ${batches.length} batches in parallel...`);
    
    const embeddingPromises = batches.map(async (batch, index) => {
      const textsToEmbed = batch.map(c => c.content);
      const embeddings = await ai.getEmbeddings(textsToEmbed);
      
      for (let j = 0; j < batch.length; j++) {
        batch[j].embedding = embeddings[j];
      }
      console.log(`Generated embeddings for batch ${index + 1}/${batches.length}`);
    });
    
    await Promise.all(embeddingPromises);
    
    // Check if the document was cancelled/deleted during embedding generation
    const docCheck2 = await db.query('SELECT id FROM documents WHERE id = $1', [documentId]);
    if (docCheck2.rows.length === 0) {
      console.log(`Document ID ${documentId} was cancelled during embedding. Aborting.`);
      return;
    }
    
    // 4. Save chunks and embeddings to database
    await vectorStore.saveChunks(documentId, allChunks);
    
    // 5. Update document status to processed
    await db.query(
      'UPDATE documents SET status = $1 WHERE id = $2',
      ['processed', documentId]
    );
    console.log(`Document processing completed successfully for ID: ${documentId}`);
    
  } catch (error) {
    // If the document was deleted mid-flight, exit cleanly
    const docExists = await db.query('SELECT id FROM documents WHERE id = $1', [documentId]);
    if (docExists.rows.length === 0) {
      console.log(`Document ID ${documentId} was deleted/cancelled during processing. Pipeline exited cleanly.`);
      return;
    }
    
    console.error(`Failed to process document ID: ${documentId}. Error:`, error);
    // Update document status to failed
    await db.query(
      'UPDATE documents SET status = $1 WHERE id = $2',
      ['failed', documentId]
    );
  } finally {
    // Delete file locally to save space if needed, or keep it.
    // For MVP, we can keep it in backend/uploads for potential debugging or page re-renders.
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
      // Insert document record as 'processing'
      const insertResult = await db.query(
        'INSERT INTO documents (user_id, filename, file_path, status) VALUES ($1, $2, $3, $4) RETURNING *',
        [userId, filename, filePath, 'processing']
      );
      
      const document = insertResult.rows[0];
      
      // Trigger background processing (WITHOUT await, to return HTTP response immediately)
      runProcessingPipeline(document.id, filePath);
      
      return res.status(202).json({
        message: 'Document uploaded and is currently processing in the background.',
        document
      });
      
    } catch (error) {
      console.error('Error inserting document record:', error);
      // Clean up uploaded file if DB insert fails
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

// Controller to get details of a specific document
async function getDocument(req, res, next) {
  const userId = req.user.id;
  const docId = req.params.id;
  
  try {
    const result = await db.query(
      'SELECT id, filename, status, created_at FROM documents WHERE id = $1 AND user_id = $2',
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
    // Verify document exists and belongs to this user
    const selectResult = await db.query(
      'SELECT id, file_path FROM documents WHERE id = $1 AND user_id = $2',
      [docId, userId]
    );
    
    if (selectResult.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found or unauthorized' });
    }
    
    const doc = selectResult.rows[0];
    const filePath = doc.file_path;
    
    // Delete from database (this will cascade delete chunks and chat history)
    await db.query('DELETE FROM documents WHERE id = $1', [docId]);
    
    // Delete file from disk
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        console.log(`Unlinked file from disk: ${filePath}`);
      } catch (err) {
        console.error(`Failed to delete file from disk: ${filePath}. Error: ${err.message}`);
      }
    }
    
    return res.json({ message: 'Document cancelled and deleted successfully' });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  uploadDocument,
  listDocuments,
  getDocument,
  deleteDocument
};
