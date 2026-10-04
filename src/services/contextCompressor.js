/**
 * Context Compression & Re-ranking Service
 * Filters, deduplicates, and structures retrieved hybrid chunks 
 * to provide optimal, non-redundant context for LLM prompt generation.
 */

/**
 * Calculates token jaccard similarity between two texts.
 */
function jaccardSimilarity(textA, textB) {
  const setA = new Set(textA.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const setB = new Set(textB.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Compresses and deduplicates retrieved chunks into a high-density context block.
 * @param {Array<{id: number, page_number: number, heading: string, content: string, filename?: string, score?: number}>} chunks 
 * @param {string} queryText 
 * @param {number} maxChars - Maximum context token/character budget
 * @returns {{compressedChunks: Array, formattedContext: string}}
 */
function compressContext(chunks, queryText, maxChars = 7500) {
  if (!chunks || chunks.length === 0) {
    return { compressedChunks: [], formattedContext: "" };
  }

  const queryKeywords = (queryText || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(k => k.length > 2);

  const selectedChunks = [];
  let totalLength = 0;

  for (const chunk of chunks) {
    const rawContent = (chunk.content || "").trim();
    if (!rawContent) continue;

    // Check near-duplicate similarity with already selected chunks (Jaccard > 0.65)
    let isDuplicate = false;
    for (const prev of selectedChunks) {
      if (jaccardSimilarity(rawContent, prev.content) > 0.65) {
        isDuplicate = true;
        break;
      }
    }
    if (isDuplicate) {
      continue;
    }

    let finalContent = rawContent;

    // For very long chunks (> 1400 chars) that are not tables, prioritize keyword-dense paragraphs
    const isTable = rawContent.startsWith('| ') || rawContent.includes(' | --- |');
    if (!isTable && rawContent.length > 1400 && queryKeywords.length > 0) {
      const paragraphs = rawContent.split(/\n\n+/);
      if (paragraphs.length > 2) {
        const scoredParagraphs = paragraphs.map(p => {
          const lowerP = p.toLowerCase();
          let kwMatches = 0;
          queryKeywords.forEach(kw => {
            if (lowerP.includes(kw)) kwMatches++;
          });
          return { text: p, score: kwMatches };
        });

        // Keep top paragraphs with matches + context
        const matched = scoredParagraphs.filter(p => p.score > 0).map(p => p.text);
        if (matched.length > 0) {
          finalContent = matched.join('\n\n');
        }
      }
    }

    // Budget check
    if (totalLength + finalContent.length > maxChars && selectedChunks.length >= 3) {
      break;
    }

    totalLength += finalContent.length;
    selectedChunks.push({
      ...chunk,
      content: finalContent
    });
  }

  // Format structured prompt context
  const formattedContext = selectedChunks
    .map((chunk, idx) => {
      const docLabel = chunk.filename ? `[Document: ${chunk.filename}] ` : '';
      const sectionLabel = chunk.heading ? ` [Section: ${chunk.heading}]` : '';
      const pageLabel = `[Page ${chunk.page_number}]`;
      return `--- Context Source ${idx + 1} ${docLabel}${pageLabel}${sectionLabel} ---\n${chunk.content}`;
    })
    .join('\n\n');

  return {
    compressedChunks: selectedChunks,
    formattedContext
  };
}

module.exports = {
  compressContext
};
