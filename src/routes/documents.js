const express = require('express');
const router = express.Router();
const documentsController = require('../controllers/documents');
const authenticateToken = require('../middleware/auth');

router.post('/upload', authenticateToken, documentsController.uploadDocument);
router.get('/', authenticateToken, documentsController.listDocuments);
router.get('/:id', authenticateToken, documentsController.getDocument);
router.get('/:id/graph', authenticateToken, documentsController.getConceptGraph);
router.post('/:id/graph/generate', authenticateToken, documentsController.regenerateConceptGraph);
router.delete('/:id', authenticateToken, documentsController.deleteDocument);

module.exports = router;
