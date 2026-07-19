try {
  console.log('Testing module compilation and imports...');
  
  console.log('1. Importing DB config...');
  const db = require('../config/db');
  
  console.log('2. Importing Database Setup...');
  const initDb = require('../config/initDb');
  
  console.log('3. Importing PDF Processor...');
  const pdfProcessor = require('../services/pdfProcessor');
  
  console.log('4. Importing OpenAI service...');
  const ai = require('../services/ai');
  
  console.log('5. Importing Vector Store...');
  const vectorStore = require('../services/vectorStore');
  
  console.log('6. Importing Auth Controller...');
  const authController = require('../controllers/auth');
  
  console.log('7. Importing Documents Controller...');
  const documentsController = require('../controllers/documents');
  
  console.log('8. Importing Chat Controller...');
  const chatController = require('../controllers/chat');
  
  console.log('9. Importing JWT Middleware...');
  const authMiddleware = require('../middleware/auth');
  
  console.log('10. Importing Error Handler...');
  const errorHandler = require('../middleware/errorHandler');

  console.log('\x1b[32m%s\x1b[0m', '✔ All modules imported successfully with no compilation errors!');
  process.exit(0);
} catch (error) {
  console.error('\x1b[31m%s\x1b[0m', '✖ Compilation verification failed:', error);
  process.exit(1);
}
