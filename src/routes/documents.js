const express = require('express');
const router = express.Router();
const documentsController = require('../controllers/documents');
const authenticateToken = require('../middleware/auth');

router.post('/upload', authenticateToken, documentsController.uploadDocument);
router.get('/', authenticateToken, documentsController.listDocuments);
router.get('/:id', authenticateToken, documentsController.getDocument);
router.delete('/:id', authenticateToken, documentsController.deleteDocument);

module.exports = router;
