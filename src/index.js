const express = require('express');
const cors = require('cors');
require('dotenv').config();

const initDatabase = require('./config/initDb');
const authRoutes = require('./routes/auth');
const documentRoutes = require('./routes/documents');
const chatRoutes = require('./routes/chat');
const errorHandler = require('./middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS
app.use(cors());

// Parse JSON request bodies
app.use(express.json());

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/chat', chatRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date() });
});

// Root status endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'DocuMind AI Backend API',
    status: 'online',
    version: '1.0.0',
    documentation: '/health'
  });
});

// Lazy DB initialization for serverless / Vercel
let dbInitialized = false;
app.use(async (req, res, next) => {
  if (!dbInitialized && (process.env.VERCEL || process.env.NODE_ENV === 'production')) {
    try {
      await initDatabase();
      dbInitialized = true;
    } catch (err) {
      console.error('Serverless DB auto-init warning:', err.message);
    }
  }
  next();
});

// Global Error Handler
app.use(errorHandler);

// Initialize DB and start server (for local execution)
async function startServer() {
  try {
    // Run migrations/table creation
    await initDatabase();
    
    app.listen(PORT, () => {
      console.log(`=========================================`);
      console.log(`DocuMind AI Backend running on port ${PORT}`);
      console.log(`=========================================`);
    });
  } catch (error) {
    console.error('Failed to start server due to database initialization failure:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = app;
