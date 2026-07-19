const { spawn } = require('child_process');
const path = require('path');

/**
 * Executes python text extraction script and returns structured text by page.
 * @param {string} pdfPath - Absolute path to the PDF file
 * @returns {Promise<Array<{page: number, text: string}>>}
 */
function extractTextFromPdf(pdfPath) {
  return new Promise((resolve, reject) => {
    // Resolve absolute path to python script
    const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'extract_text.py');

    // Use the virtual environment python executable if it exists
    const fs = require('fs');
    const venvPythonPath = process.platform === 'win32'
      ? path.join(__dirname, '..', '..', 'venv', 'Scripts', 'python.exe')
      : path.join(__dirname, '..', '..', 'venv', 'bin', 'python');
    
    const pythonCommand = fs.existsSync(venvPythonPath) ? venvPythonPath : 'python';

    // Spawn python process
    const pythonProcess = spawn(pythonCommand, [scriptPath, pdfPath]);

    let stdoutData = '';
    let stderrData = '';

    pythonProcess.stdout.on('data', (data) => {
      stdoutData += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    pythonProcess.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Python extraction process exited with code ${code}. Error: ${stderrData}`));
      }

      try {
        const pages = JSON.parse(stdoutData);
        resolve(pages);
      } catch (parseError) {
        reject(new Error(`Failed to parse Python script output: ${parseError.message}. Raw output: ${stdoutData}`));
      }
    });

    pythonProcess.on('error', (err) => {
      reject(new Error(`Failed to start Python extraction process: ${err.message}`));
    });
  });
}

/**
 * Splits text into overlapping chunks.
 * @param {string} text - Input text string
 * @param {number} maxChunkSize - Max characters per chunk (default: 1000)
 * @param {number} overlap - Character overlap between chunks (default: 200)
 * @returns {Array<string>}
 */
function chunkText(text, maxChunkSize = 1000, overlap = 200) {
  if (!text || text.trim() === '') return [];

  const chunks = [];
  let startIndex = 0;

  while (startIndex < text.length) {
    let endIndex = startIndex + maxChunkSize;

    // If we're not at the end of the text, try to break at a space or newline to keep words intact
    if (endIndex < text.length) {
      const lastSpace = text.lastIndexOf(' ', endIndex);
      const lastNewline = text.lastIndexOf('\n', endIndex);
      const bestBreak = Math.max(lastSpace, lastNewline);

      // Avoid breaking too early if space/newline is far back (e.g. keep at least 70% of max size)
      if (bestBreak > startIndex + (maxChunkSize * 0.7)) {
        endIndex = bestBreak;
      }
    } else {
      endIndex = text.length;
    }

    const chunk = text.substring(startIndex, endIndex).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    // If we reached the end of the text, we are done
    if (endIndex >= text.length) {
      break;
    }

    startIndex = endIndex - overlap;
    // Safety check to prevent infinite loops
    if (overlap >= maxChunkSize || startIndex >= endIndex) {
      startIndex = endIndex;
    }
  }

  return chunks;
}

module.exports = {
  extractTextFromPdf,
  chunkText
};
