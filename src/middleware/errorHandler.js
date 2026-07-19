function errorHandler(err, req, res, next) {
  console.error('Unhandled Server Error:', err);
  
  const statusCode = err.statusCode || 500;
  const message = err.message || 'An unexpected error occurred';
  
  res.status(statusCode).json({
    error: message,
    // Only send stack trace in development mode
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
}

module.exports = errorHandler;
