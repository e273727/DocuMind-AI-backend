const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Executes python text extraction script with PyMuPDF table detection,
 * heading hierarchy analysis, text cleaning, and semantic chunking.
 * @param {string} pdfPath - Absolute path to the PDF file
 * @returns {Promise<{
 *   chunks: Array<{chunk_index: number, page: number, heading: string, section_path: string, content: string, content_type: string, tokens_est: number, summary_hint: string}>,
 *   document_summary_hint: string,
 *   total_chunks: number,
 *   tables_detected: number,
 *   pages_count: number
 * }>}
 */
function extractAndChunkPdf(pdfPath) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'extract_text.py');

    const venvPythonPath = process.platform === 'win32'
      ? path.join(__dirname, '..', '..', 'venv', 'Scripts', 'python.exe')
      : path.join(__dirname, '..', '..', 'venv', 'bin', 'python');
    
    const pythonCommand = fs.existsSync(venvPythonPath) ? venvPythonPath : 'python';

    const pythonProcess = spawn(pythonCommand, [scriptPath, pdfPath], {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });

    let stdoutData = '';
    let stderrData = '';

    pythonProcess.stdout.on('data', (data) => {
      stdoutData += data.toString('utf-8');
    });

    pythonProcess.stderr.on('data', (data) => {
      stderrData += data.toString('utf-8');
    });

    pythonProcess.on('close', (code) => {
      const elapsed = Date.now() - startTime;
      if (code !== 0) {
        return reject(new Error(`Python extraction process exited with code ${code} after ${elapsed}ms. Error: ${stderrData.trim()}`));
      }

      try {
        const firstBrace = stdoutData.indexOf('{');
        const lastBrace = stdoutData.lastIndexOf('}');
        if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
          throw new Error('No valid JSON object found in Python extraction output');
        }
        const jsonStr = stdoutData.slice(firstBrace, lastBrace + 1);
        const result = JSON.parse(jsonStr);
        console.log(`[PDF Extraction] Completed in ${elapsed}ms: ${result.pages_count || 0} pages, ${result.total_chunks || 0} chunks, ${result.tables_detected || 0} tables.`);
        resolve(result);
      } catch (parseError) {
        reject(new Error(`Failed to parse Python extraction output (${parseError.message}). Raw output preview: ${stdoutData.slice(0, 300)}...`));
      }
    });

    pythonProcess.on('error', (err) => {
      reject(new Error(`Failed to start Python extraction process: ${err.message}`));
    });
  });
}

module.exports = {
  extractAndChunkPdf
};
