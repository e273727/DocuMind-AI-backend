const express = require('express');
const router = express.Router();
const chatController = require('../controllers/chat');
const authenticateToken = require('../middleware/auth');

router.post('/', authenticateToken, chatController.askQuestion);
router.get('/:documentId', authenticateToken, chatController.getChatHistory);
router.get('/history/:documentId', authenticateToken, chatController.getChatHistory);

module.exports = router;
