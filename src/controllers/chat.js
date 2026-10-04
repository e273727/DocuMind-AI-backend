const db = require('../config/db');
const ai = require('../services/ai');
const vectorStore = require('../services/vectorStore');
const contextCompressor = require('../services/contextCompressor');

// Controller to handle asking a question about a document
async function askQuestion(req, res, next) {
  const userId = req.user.id;
  const { documentId, documentIds, question } = req.body;
  
  if ((!documentId && !documentIds) || !question || !question.trim()) {
    return res.status(400).json({ error: 'documentId (or documentIds) and question are required' });
  }

  const cleanQuestion = question.trim();

  // Deduplicate and parse IDs
  const rawIds = documentIds || (documentId ? [documentId] : []);
  const ids = [...new Set(rawIds.map(id => parseInt(id)).filter(Boolean))];

  if (ids.length === 0) {
    return res.status(400).json({ error: 'At least one valid documentId is required' });
  }

  if (ids.length > 5) {
    return res.status(400).json({ error: 'You can query up to 5 documents simultaneously' });
  }
  
  try {
    // 1. Verify all documents exist and belong to this user
    const docCheck = await db.query(
      'SELECT id, status, filename FROM documents WHERE id = ANY($1::int[]) AND user_id = $2',
      [ids, userId]
    );
    
    if (docCheck.rows.length !== ids.length) {
      return res.status(404).json({ error: 'One or more documents not found or unauthorized' });
    }
    
    const unprocessedDocs = docCheck.rows.filter(doc => doc.status !== 'processed');
    if (unprocessedDocs.length > 0) {
      const names = unprocessedDocs.map(d => d.filename).join(', ');
      return res.status(400).json({ 
        error: `Some documents are not ready for querying yet: ${names}` 
      });
    }
    
    const sortedIds = [...ids].sort((a, b) => a - b);

    // 2. Retrieve recent conversation history for multi-turn contextualization
    const historyRes = await db.query(
      `SELECT question, answer 
       FROM chat_history 
       WHERE user_id = $1 AND (
         (document_ids = $2::int[]) OR 
         (cardinality($2::int[]) = 1 AND document_id = $3)
       ) 
       ORDER BY created_at DESC 
       LIMIT 4`,
      [userId, sortedIds, sortedIds[0]]
    );

    const recentHistory = (historyRes.rows || []).reverse();

    // 3. Multi-Turn Conversational Query Reformulation (resolve pronouns & contextual references)
    const standaloneQuery = await ai.reformulateQuery(cleanQuestion, recentHistory);
    
    // 4. Generate Embedding for the reformulated standalone query
    const queryEmbedding = await ai.getEmbedding(standaloneQuery);
    
    // 5. High-Precision Hybrid Retrieval (pgvector + stopword-filtered tsvector + heading boost + weighted RRF)
    const hybridChunks = await vectorStore.searchHybridChunks(ids, standaloneQuery, queryEmbedding, 8);
    
    if (hybridChunks.length === 0) {
      return res.status(404).json({ 
        error: 'No content chunks found for the selected documents.' 
      });
    }
    
    // 6. Context Compression & Re-ranking (Deduplication, coverage diversity, budget fitting)
    const { compressedChunks, formattedContext } = contextCompressor.compressContext(hybridChunks, standaloneQuery);

    // 7. Grounded Answer Generation with Citations & Dynamic Follow-up Suggestions
    const { answer, followUpQuestions } = await ai.generateAnswer(
      cleanQuestion, 
      compressedChunks, 
      formattedContext,
      recentHistory
    );
    
    // 8. Construct rich sources
    const sources = compressedChunks.map(chunk => ({
      filename: chunk.filename,
      page_number: chunk.page_number,
      heading: chunk.heading || 'General Overview',
      content: chunk.content,
      score: chunk.score ? Math.min(Number(chunk.score), 1.0) : 0.85
    }));

    // 9. Save QA pair to chat history
    const saveResult = await db.query(
      `INSERT INTO chat_history (user_id, document_id, question, answer, sources, document_ids) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       RETURNING id, created_at`,
      [userId, sortedIds[0], cleanQuestion, answer, JSON.stringify(sources), sortedIds]
    );
    
    // 10. Return rich response to client
    return res.json({
      chatId: saveResult.rows[0].id,
      question: cleanQuestion,
      answer,
      sources,
      followUpQuestions: followUpQuestions || [],
      created_at: saveResult.rows[0].created_at
    });
    
  } catch (error) {
    next(error);
  }
}

// Controller to retrieve chat history for a specific document or combination of documents
async function getChatHistory(req, res, next) {
  const userId = req.user.id;
  const { documentId } = req.params;
  
  if (!documentId) {
    return res.status(400).json({ error: 'documentId is required' });
  }
  
  const rawIds = documentId.split(',').map(id => parseInt(id.trim())).filter(Boolean);
  const ids = [...new Set(rawIds)];

  if (ids.length === 0) {
    return res.status(400).json({ error: 'At least one valid documentId is required' });
  }

  try {
    const docCheck = await db.query(
      'SELECT id FROM documents WHERE id = ANY($1::int[]) AND user_id = $2',
      [ids, userId]
    );
    
    if (docCheck.rows.length !== ids.length) {
      return res.status(404).json({ error: 'One or more documents not found or unauthorized' });
    }
    
    const sortedIds = [...ids].sort((a, b) => a - b);

    const result = await db.query(
      `SELECT id, question, answer, sources, created_at 
       FROM chat_history 
       WHERE user_id = $1 AND (
         (document_ids = $2::int[]) OR 
         (cardinality($2::int[]) = 1 AND document_id = $3 AND document_ids IS NULL)
       ) 
       ORDER BY created_at ASC`,
      [userId, sortedIds, sortedIds[0]]
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
