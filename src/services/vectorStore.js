const db = require('../config/db');

// Common English stopwords and conversational filler to strip from keyword queries
const STOP_WORDS = new Set([
  'what', 'is', 'the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'by', 'for', 'with', 'about',
  'against', 'between', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 'to',
  'from', 'up', 'down', 'of', 'off', 'over', 'under', 'again', 'further', 'then', 'once', 'here',
  'there', 'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most',
  'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too',
  'very', 'can', 'will', 'just', 'should', 'now', 'tell', 'me', 'explain', 'describe', 'give',
  'show', 'does', 'did', 'do', 'are', 'were', 'was', 'be', 'been', 'being', 'have', 'has', 'had'
]);

/**
 * Clean and build an optimized query string for plainto_tsquery.
 */
function buildTsQuery(queryText) {
  if (!queryText) return null;
  
  const tokens = queryText
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w));
    
  if (tokens.length === 0) {
    const fallback = queryText.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
    return fallback.length >= 2 ? fallback : null;
  }
  
  return tokens.join(' ');
}

/**
 * Stores multiple chunks, headings, summaries, metadata, and vector embeddings in PostgreSQL.
 * Auto-populates PostgreSQL tsvector for hybrid keyword search.
 * @param {number} documentId - The associated document ID
 * @param {Array<{content: string, pageNumber: number, heading?: string, section_path?: string, content_type?: string, summary_hint?: string, metadata?: object, embedding: Array<number>}>} chunks 
 * @returns {Promise<void>}
 */
async function saveChunks(documentId, chunks) {
  if (!chunks || chunks.length === 0) return;
  
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    
    // Process in batches of 50 to avoid parameter limit issues in single SQL statement
    const batchSize = 50;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const queryParts = [];
      const values = [];
      let paramCounter = 1;

      for (const chunk of batch) {
        const vectorStr = `[${chunk.embedding.join(',')}]`;
        const heading = chunk.heading || 'General Overview';
        const sectionPath = chunk.section_path || heading;
        const summary = chunk.summary_hint || null;
        const metadataJson = JSON.stringify(chunk.metadata || { 
          page: chunk.pageNumber, 
          heading,
          section_path: sectionPath,
          content_type: chunk.content_type || 'text'
        });

        queryParts.push(
          `($${paramCounter}, $${paramCounter + 1}, $${paramCounter + 2}, $${paramCounter + 3}::varchar, $${paramCounter + 4}::text, $${paramCounter + 5}::jsonb, $${paramCounter + 6}::vector, to_tsvector('english', coalesce($${paramCounter + 3}::text, '') || ' ' || coalesce($${paramCounter + 4}::text, '') || ' ' || $${paramCounter + 1}))`
        );
        values.push(documentId, chunk.content, chunk.pageNumber, heading, summary, metadataJson, vectorStr);
        paramCounter += 7;
      }

      const sql = `
        INSERT INTO document_chunks (document_id, content, page_number, heading, summary, metadata, embedding, tsv)
        VALUES ${queryParts.join(', ')}
      `;

      await client.query(sql, values);
    }
    
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
 * Saves document-level summary to PostgreSQL database.
 * @param {number} documentId - Document ID
 * @param {string} summary - Document overall summary
 * @param {Array<string>} keyTakeaways - Array of key takeaway points
 */
async function saveDocumentSummary(documentId, summary, keyTakeaways = []) {
  const sql = `
    INSERT INTO document_summaries (document_id, summary, key_takeaways)
    VALUES ($1, $2, $3::jsonb)
    ON CONFLICT (document_id) 
    DO UPDATE SET summary = EXCLUDED.summary, key_takeaways = EXCLUDED.key_takeaways;
  `;
  try {
    await db.query(sql, [documentId, summary, JSON.stringify(keyTakeaways)]);
  } catch (error) {
    console.error('Error saving document summary:', error);
  }
}

/**
 * Retrieve document summary from PostgreSQL.
 * @param {number} documentId 
 */
async function getDocumentSummary(documentId) {
  const sql = `SELECT summary, key_takeaways FROM document_summaries WHERE document_id = $1`;
  const res = await db.query(sql, [documentId]);
  return res.rows[0] || null;
}

/**
 * High-Precision Hybrid Retrieval combining Vector Cosine Search (pgvector)
 * and Keyword Search (tsvector full-text + heading boost), fused with weighted RRF.
 * @param {number|number[]} documentIds - The document ID(s) to query
 * @param {string} queryText - The text question for keyword search
 * @param {Array<number>} queryEmbedding - The vector embedding of the question
 * @param {number} topK - Number of top fused chunks to return
 * @returns {Promise<Array<{id: number, page_number: number, heading: string, content: string, distance: number, score: number, filename: string}>>}
 */
async function searchHybridChunks(documentIds, queryText, queryEmbedding, topK = 8) {
  const ids = Array.isArray(documentIds) ? documentIds : [documentIds];
  const vectorStr = `[${queryEmbedding.join(',')}]`;
  const fetchLimit = Math.max(topK * 3, 20);
  
  // 1. Vector Search Query
  const vectorSql = `
    SELECT dc.id, dc.page_number, dc.heading, dc.summary, dc.content, (dc.embedding <=> $1::vector) AS distance, d.filename
    FROM document_chunks dc
    JOIN documents d ON dc.document_id = d.id
    WHERE dc.document_id = ANY($2::int[])
    ORDER BY distance ASC
    LIMIT $3
  `;

  // 2. Keyword Search Query (tsvector)
  const tsQuery = buildTsQuery(queryText);
  const keywordSql = `
    SELECT dc.id, dc.page_number, dc.heading, dc.summary, dc.content, 
           ts_rank_cd(dc.tsv, plainto_tsquery('english', $1)) AS rank, d.filename
    FROM document_chunks dc
    JOIN documents d ON dc.document_id = d.id
    WHERE dc.document_id = ANY($2::int[]) 
      AND (dc.tsv @@ plainto_tsquery('english', $1) OR dc.heading ILIKE '%' || $3 || '%')
    ORDER BY rank DESC
    LIMIT $4
  `;

  try {
    const [vectorRes, keywordRes] = await Promise.all([
      db.query(vectorSql, [vectorStr, ids, fetchLimit]),
      tsQuery
        ? db.query(keywordSql, [tsQuery, ids, queryText.slice(0, 40), fetchLimit]).catch((err) => {
            console.warn('[Hybrid Search] Keyword query notice:', err.message);
            return { rows: [] };
          })
        : Promise.resolve({ rows: [] })
    ]);

    // Reciprocal Rank Fusion (RRF) with Dense-Sparse Weights
    const kConst = 60;
    const rrfScores = new Map();
    const chunkMap = new Map();
    const queryLower = queryText.toLowerCase();

    // Process vector rankings (Weight: 1.0)
    vectorRes.rows.forEach((row, rank) => {
      const id = row.id;
      chunkMap.set(id, row);
      const score = (1.0) / (kConst + (rank + 1));
      rrfScores.set(id, (rrfScores.get(id) || 0) + score);
    });

    // Process keyword rankings (Weight: 0.85)
    keywordRes.rows.forEach((row, rank) => {
      const id = row.id;
      if (!chunkMap.has(id)) {
        chunkMap.set(id, row);
      }
      const score = (0.85) / (kConst + (rank + 1));
      rrfScores.set(id, (rrfScores.get(id) || 0) + score);
    });

    // Add Heading Match Boost
    chunkMap.forEach((item, id) => {
      if (item.heading && item.heading.toLowerCase() !== 'general overview') {
        const headingWords = item.heading.toLowerCase().split(/\s+/);
        const matchCount = headingWords.filter(w => w.length > 2 && queryLower.includes(w)).length;
        if (matchCount > 0) {
          const headingBoost = 0.005 * matchCount;
          rrfScores.set(id, (rrfScores.get(id) || 0) + headingBoost);
        }
      }
    });

    // Sort by combined RRF score
    const fusedResults = Array.from(rrfScores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([id, rrfScore]) => {
        const item = chunkMap.get(id);
        const vectorDist = item.distance !== undefined ? Number(item.distance) : 0.45;
        return {
          id: item.id,
          page_number: item.page_number,
          heading: item.heading || 'General Overview',
          summary: item.summary,
          content: item.content,
          distance: vectorDist,
          score: rrfScore,
          filename: item.filename
        };
      });

    return fusedResults;
  } catch (error) {
    console.error('Error during hybrid retrieval:', error);
    return searchSimilarChunks(documentIds, queryEmbedding, topK);
  }
}

/**
 * Legacy vector search fallback helper.
 */
async function searchSimilarChunks(documentIds, queryEmbedding, limit = 5) {
  const vectorStr = `[${queryEmbedding.join(',')}]`;
  const ids = Array.isArray(documentIds) ? documentIds : [documentIds];
  
  const sql = `
    SELECT dc.id, dc.page_number, dc.heading, dc.content, (dc.embedding <=> $1::vector) AS distance, d.filename
    FROM document_chunks dc
    JOIN documents d ON dc.document_id = d.id
    WHERE dc.document_id = ANY($2::int[])
    ORDER BY distance ASC
    LIMIT $3
  `;
  
  try {
    const result = await db.query(sql, [vectorStr, ids, limit]);
    return result.rows.map(row => ({
      id: row.id,
      page_number: row.page_number,
      heading: row.heading || 'General Overview',
      content: row.content,
      distance: Number(row.distance),
      score: 1 - Number(row.distance),
      filename: row.filename
    }));
  } catch (error) {
    console.error('Error querying vector DB:', error);
    throw error;
  }
}

module.exports = {
  saveChunks,
  saveDocumentSummary,
  getDocumentSummary,
  searchHybridChunks,
  searchSimilarChunks
};
