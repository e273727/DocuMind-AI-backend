const db = require('../config/db');
const ai = require('../services/ai');
const vectorStore = require('../services/vectorStore');

// Controller to handle asking a question about a document
async function askQuestion(req, res, next) {
  const userId = req.user.id;
  const { documentId, question } = req.body;
  
  if (!documentId || !question) {
    return res.status(400).json({ error: 'documentId and question are required' });
  }
  
  try {
    // 1. Verify document exists and belongs to this user
    const docCheck = await db.query(
      'SELECT id, status FROM documents WHERE id = $1 AND user_id = $2',
      [documentId, userId]
    );
    
    if (docCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found or unauthorized' });
    }
    
    const doc = docCheck.rows[0];
    if (doc.status !== 'processed') {
      return res.status(400).json({ 
        error: `Document is not ready for chat. Current status: ${doc.status}` 
      });
    }
    
    // 2. Generate embedding for the question
    const queryEmbedding = await ai.getEmbedding(question);
    
    // 3. Search vector DB for top 5 most similar chunks
    const similarChunks = await vectorStore.searchSimilarChunks(documentId, queryEmbedding, 5);
    
    if (similarChunks.length === 0) {
      return res.status(404).json({ 
        error: 'No content chunks found for this document. Try re-processing.' 
      });
    }
    
    // 4. Generate answer using retrieved context
    const answer = await ai.generateAnswer(question, similarChunks);
    
    // 5. Construct sources references to save and return
    const sources = similarChunks.map(chunk => ({
      page_number: chunk.page_number,
      content: chunk.content,
      score: 1 - chunk.distance // cosine similarity score
    }));
    
    // 6. Save QA pair to chat history
    const saveResult = await db.query(
      `INSERT INTO chat_history (user_id, document_id, question, answer, sources) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING id, created_at`,
      [userId, documentId, question, answer, JSON.stringify(sources)]
    );
    
    // 7. Return response
    return res.json({
      chatId: saveResult.rows[0].id,
      question,
      answer,
      sources,
      created_at: saveResult.rows[0].created_at
    });
    
  } catch (error) {
    next(error);
  }
}

// Controller to retrieve chat history for a specific document
async function getChatHistory(req, res, next) {
  const userId = req.user.id;
  const { documentId } = req.params;
  
  if (!documentId) {
    return res.status(400).json({ error: 'documentId is required' });
  }
  
  try {
    // Verify document ownership
    const docCheck = await db.query(
      'SELECT id FROM documents WHERE id = $1 AND user_id = $2',
      [documentId, userId]
    );
    
    if (docCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found or unauthorized' });
    }
    
    const result = await db.query(
      `SELECT id, question, answer, sources, created_at 
       FROM chat_history 
       WHERE user_id = $1 AND document_id = $2 
       ORDER BY created_at ASC`,
      [userId, documentId]
    );
    
    return res.json(result.rows);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  askQuestion,
  getChatHistory
};
