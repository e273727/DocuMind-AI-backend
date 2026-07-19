const db = require('../config/db');

/**
 * Stores multiple chunks and their vector embeddings in the database.
 * Uses a single batch insert query or transactions for efficiency.
 * @param {number} documentId - The associated document ID
 * @param {Array<{content: string, pageNumber: number, embedding: Array<number>}>} chunks - Array of chunk items
 * @returns {Promise<void>}
 */
async function saveChunks(documentId, chunks) {
  if (!chunks || chunks.length === 0) return;
  
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    
    // We construct a query with multiple values: ($1, $2, $3, $4), ($5, $6, $7, $8)...
    const queryParts = [];
    const values = [];
    let paramCounter = 1;
    
    for (const chunk of chunks) {
      // Postgres vector format expects bracketed numbers like '[0.1, 0.2, ...]'
      const vectorStr = `[${chunk.embedding.join(',')}]`;
      
      queryParts.push(`($${paramCounter}, $${paramCounter + 1}, $${paramCounter + 2}, $${paramCounter + 3}::vector)`);
      values.push(documentId, chunk.content, chunk.pageNumber, vectorStr);
      paramCounter += 4;
    }
    
    const sql = `
      INSERT INTO document_chunks (document_id, content, page_number, embedding)
      VALUES ${queryParts.join(', ')}
    `;
    
    await client.query(sql, values);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error saving chunks to DB:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Perform cosine distance vector search to locate top-k relevant chunks.
 * @param {number} documentId - The document to query
 * @param {Array<number>} queryEmbedding - The embedding vector of the question
 * @param {number} limit - Number of top chunks to return (default: 5)
 * @returns {Promise<Array<{id: number, page_number: number, content: string, distance: number}>>}
 */
async function searchSimilarChunks(documentId, queryEmbedding, limit = 5) {
  const vectorStr = `[${queryEmbedding.join(',')}]`;
  const sql = `
    SELECT id, page_number, content, (embedding <=> $1::vector) AS distance
    FROM document_chunks
    WHERE document_id = $2
    ORDER BY distance ASC
    LIMIT $3
  `;
  
  try {
    const result = await db.query(sql, [vectorStr, documentId, limit]);
    // mapping fields to standard names
    return result.rows.map(row => ({
      id: row.id,
      page_number: row.page_number,
      content: row.content,
      distance: Number(row.distance)
    }));
  } catch (error) {
    console.error('Error querying vector DB:', error);
    throw error;
  }
}

module.exports = {
  saveChunks,
  searchSimilarChunks
};
