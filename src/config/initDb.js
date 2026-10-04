const { pool } = require('./db');

const initSql = `
  -- Enable pgvector extension
  CREATE EXTENSION IF NOT EXISTS vector;

  -- Users Table
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  );

  -- Documents Table
  CREATE TABLE IF NOT EXISTS documents (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,
    file_path VARCHAR(512) NOT NULL,
    status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'processing', 'processed', 'failed'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  );

  -- Document Chunks Table
  CREATE TABLE IF NOT EXISTS document_chunks (
    id SERIAL PRIMARY KEY,
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    page_number INTEGER NOT NULL,
    embedding vector(2048)
  );

  -- Add heading, summary, metadata, and tsvector columns to document_chunks
  ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS heading VARCHAR(512);
  ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS summary TEXT;
  ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS metadata JSONB;
  ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS tsv tsvector;

  -- Create GIN index for keyword text search on tsvector
  CREATE INDEX IF NOT EXISTS document_chunks_tsv_idx ON document_chunks USING gin(tsv);

  -- Document Summaries Table (PostgreSQL persistent summaries storage)
  CREATE TABLE IF NOT EXISTS document_summaries (
    id SERIAL PRIMARY KEY,
    document_id INTEGER UNIQUE REFERENCES documents(id) ON DELETE CASCADE,
    summary TEXT NOT NULL,
    key_takeaways JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  );

  -- Chat History Table
  CREATE TABLE IF NOT EXISTS chat_history (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    sources JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  );

  -- Add document_ids column for multi-document support
  ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS document_ids INTEGER[];

  -- Add graph_data column for persistent concept flowchart storing
  ALTER TABLE documents ADD COLUMN IF NOT EXISTS graph_data JSONB;
`;

async function initDatabase() {
  try {
    console.log('Initializing database schema...');
    await pool.query(initSql);
    console.log('Database schema initialized successfully');
  } catch (error) {
    console.error('Error initializing database schema:', error);
    throw error;
  }
}

module.exports = initDatabase;

// If run directly (e.g. node initDb.js)
if (require.main === module) {
  initDatabase().then(() => process.exit(0)).catch(() => process.exit(1));
}
