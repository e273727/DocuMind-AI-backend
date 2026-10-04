const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn('⚠️ WARNING: DATABASE_URL is not defined in environment variables. Database operations will fail.');
}

const isProduction = process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
const isCloudUrl = connectionString && (
  connectionString.includes('neon.tech') ||
  connectionString.includes('supabase.co') ||
  connectionString.includes('render.com') ||
  connectionString.includes('railway.app') ||
  connectionString.includes('sslmode=require') ||
  connectionString.includes('pooler.supabase.com')
);

const useSsl = process.env.DB_SSL === 'true' || (isProduction && !connectionString?.includes('localhost')) || isCloudUrl;

const pool = new Pool({
  connectionString,
  ssl: useSsl ? { rejectUnauthorized: false } : false
});

pool.on('connect', () => {
  console.log('PostgreSQL connection pool established');
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client:', err.message);
  // Do not exit process in serverless / Vercel
  if (!process.env.VERCEL) {
    // Only exit in standalone container/local environments if critical
  }
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
