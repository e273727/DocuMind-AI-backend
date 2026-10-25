const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'documind_secret_session_jwt_token_2026';

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  // Token usually comes as 'Bearer <token>' or query parameter 'token'
  const token = (authHeader && authHeader.split(' ')[1]) || req.query.token;

  if (!token) {
    return res.status(401).json({ error: 'Access token is required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      const isExpired = err.name === 'TokenExpiredError';
      return res.status(401).json({ 
        error: isExpired ? 'Session expired. Please log in again.' : 'Invalid access token',
        expired: isExpired 
      });
    }
    
    // Store user info in request context
    req.user = {
      id: user.id,
      email: user.email
    };
    next();
  });
}

module.exports = authenticateToken;
