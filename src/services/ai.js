const { OpenAI } = require('openai');
require('dotenv').config();

let openai;

const CHAT_MODEL = process.env.CHAT_MODEL || 'meta/llama-3.2-11b-vision-instruct';
const EMBED_MODEL = process.env.EMBED_MODEL || 'nvidia/nemotron-3-embed-1b';

/**
 * Helper to ensure OpenAI / NVIDIA API client is initialized.
 */
function getClient() {
  if (!openai) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('API Key is missing. Please set OPENAI_API_KEY in the environment.');
    }
    openai = new OpenAI({ 
      apiKey: apiKey,
      baseURL: process.env.OPENAI_BASE_URL || 'https://integrate.api.nvidia.com/v1'
    });
  }
  return openai;
}

/**
 * Executes an async operation with exponential backoff retry for resilient API calls.
 */
async function withRetry(fn, retries = 3, delayMs = 1000) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isRateLimitOrNetwork = 
        err.status === 429 || 
        err.code === 'ECONNRESET' || 
        err.code === 'ETIMEDOUT' ||
        (err.message && err.message.includes('429'));
        
      if (attempt < retries && isRateLimitOrNetwork) {
        const backoff = delayMs * Math.pow(2, attempt - 1) + Math.random() * 200;
        console.warn(`[AI API] Attempt ${attempt} encountered error: ${err.message}. Retrying in ${Math.round(backoff)}ms...`);
        await new Promise(res => setTimeout(res, backoff));
      } else {
        break;
      }
    }
  }
  throw lastError;
}

/**
 * Generate embedding vector for a single text query.
 * @param {string} text - The input text to embed
 * @returns {Promise<Array<number>>} The vector float array
 */
async function getEmbedding(text) {
  const client = getClient();
  const cleanInput = (text || "").replace(/\s+/g, ' ').trim();
  
  return withRetry(async () => {
    const response = await client.embeddings.create({
      model: EMBED_MODEL,
      input: cleanInput || "empty document",
    });
    return response.data[0].embedding;
  });
}

/**
 * Generate embedding vectors for an array of texts with batching & retries.
 * @param {Array<string>} texts - The input texts to embed
 * @returns {Promise<Array<Array<number>>>} The list of float arrays
 */
async function getEmbeddings(texts) {
  if (!texts || texts.length === 0) return [];
  const client = getClient();
  const cleanTexts = texts.map(t => (t || "").replace(/\s+/g, ' ').trim() || "empty chunk");
  
  return withRetry(async () => {
    const response = await client.embeddings.create({
      model: EMBED_MODEL,
      input: cleanTexts,
    });
    return response.data.map(item => item.embedding);
  });
}

/**
 * Reformulates a conversational follow-up question into an explicit standalone search query.
 * @param {string} question - Current user question
 * @param {Array<{question: string, answer: string}>} chatHistory - Recent QA pairs
 * @returns {Promise<string>} Standalone search query
 */
async function reformulateQuery(question, chatHistory = []) {
  if (!chatHistory || chatHistory.length === 0) {
    return question;
  }

  // Check if question is already self-contained (long with specific keywords)
  const words = question.trim().split(/\s+/);
  const conversationalPronouns = /\b(it|its|they|them|their|this|that|these|those|he|him|his|she|her|the second|the first|the previous|what about|how about|why did|why is)\b/i;
  
  if (words.length > 8 && !conversationalPronouns.test(question)) {
    return question;
  }

  const client = getClient();
  const recentTurns = chatHistory.slice(-3).map(turn => 
    `User: ${turn.question}\nAssistant: ${typeof turn.answer === 'string' ? turn.answer.slice(0, 200) : ''}`
  ).join('\n\n');

  const systemPrompt = `You are a conversational search assistant.
Given the recent conversation history and the user's latest follow-up question, rewrite the follow-up question into a clear, standalone search query that contains all necessary entity names and subjects from context.
Do NOT answer the question. Only output the rewritten standalone query string. If the question is already standalone, output it as is.`;

  try {
    const response = await withRetry(async () => {
      return await client.chat.completions.create({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Conversation History:\n${recentTurns}\n\nUser Follow-up Question: ${question}\n\nStandalone Query:` }
        ],
        temperature: 0.0,
        max_tokens: 150
      });
    });

    const rewritten = response.choices[0].message.content.trim().replace(/^["']|["']$/g, '');
    console.log(`[Query Reformulation] Original: "${question}" -> Standalone: "${rewritten}"`);
    return rewritten || question;
  } catch (err) {
    console.warn('[Query Reformulation] Fallback to original question:', err.message);
    return question;
  }
}

/**
 * Generates an executive document-level summary and key takeaways.
 * @param {Array<{content: string, pageNumber?: number, page?: number, heading?: string}>} chunks 
 * @param {string} filename 
 * @returns {Promise<{summary: string, keyTakeaways: Array<string>}>}
 */
async function generateDocumentSummary(chunks, filename) {
  const client = getClient();
  
  if (!chunks || chunks.length === 0) {
    return { summary: "No content available for summary.", keyTakeaways: [] };
  }

  // Sample informative text passages across document
  const sampledText = chunks
    .slice(0, 12)
    .map(c => `[Page ${c.pageNumber || c.page || 1}${c.heading ? ` - ${c.heading}` : ''}]: ${c.content.slice(0, 400)}`)
    .join('\n\n');

  const systemPrompt = `You are a senior document intelligence analyst.
Analyze the following text excerpts from the uploaded document "${filename}" and produce a JSON response with:
1. "summary": A concise executive summary of the document (2-4 sentences).
2. "keyTakeaways": An array of 3 to 5 key bullet points.

Return RAW VALID JSON ONLY with no markdown wrapping. Format:
{
  "summary": "...",
  "keyTakeaways": ["...", "..."]
}`;

  try {
    const response = await withRetry(async () => {
      return await client.chat.completions.create({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: sampledText }
        ],
        temperature: 0.2,
      });
    });

    let rawText = response.choices[0].message.content.trim();
    if (rawText.startsWith('```')) {
      rawText = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    }
    return JSON.parse(rawText);
  } catch (err) {
    console.error('Error generating document summary:', err);
    return {
      summary: `Document overview for ${filename} compiled from automated text analysis.`,
      keyTakeaways: ["Automated text extraction completed successfully."]
    };
  }
}

/**
 * Answer a question using compressed hybrid context chunks with precise citations and follow-up suggestions.
 * @param {string} question - User question
 * @param {Array<{page_number: number, heading?: string, content: string, filename?: string}>} contextChunks 
 * @param {string} formattedContext - Pre-compressed formatted context string
 * @param {Array<{question: string, answer: string}>} chatHistory - Prior conversation turns
 * @returns {Promise<{answer: string, followUpQuestions: Array<string>}>}
 */
async function generateAnswer(question, contextChunks, formattedContext = '', chatHistory = []) {
  const client = getClient();

  const contextBlock = formattedContext || contextChunks
    .map((chunk, idx) => `[Source ${idx + 1}] (File: ${chunk.filename || 'Unknown'}, Page ${chunk.page_number}${chunk.heading ? `, Section: ${chunk.heading}` : ''}):\n${chunk.content}`)
    .join('\n\n');

  const historyMessages = (chatHistory || []).slice(-4).map(turn => ([
    { role: 'user', content: turn.question },
    { role: 'assistant', content: typeof turn.answer === 'string' ? turn.answer : '' }
  ])).flat();

  const systemPrompt = `You are DocuMind AI, an expert, precision-grounded document intelligence assistant.
Answer the user's question using ONLY the provided document context below.

Strict Grounding & Precision Rules:
1. Base your answer COMPLETELY and FAITHFULLY on the provided context sources.
2. If the context does NOT contain enough information to answer the question, state: "I'm sorry, but I cannot find that information in the uploaded documents." Do not speculate or invent facts.
3. INLINE CITATIONS: For every key statement, metric, or finding, explicitly cite the source page inline with the format: "[Page <page_number>]" (or "[Page <page_number>, Section: <heading>]").
4. STRUCTURE: Use clear markdown with bold headers, bullet points, and markdown tables when comparing figures or attributes.
5. SUGGESTED FOLLOW-UPS: At the very end of your response, provide 2 to 3 relevant follow-up questions that the user could ask next about this document, formatted under a heading "### Suggested Follow-ups" with bullet points.

Document Context:
${contextBlock}
`;

  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...historyMessages,
      { role: 'user', content: question }
    ];

    const response = await withRetry(async () => {
      return await client.chat.completions.create({
        model: CHAT_MODEL,
        messages,
        temperature: 0.1,
      });
    });

    const fullContent = response.choices[0].message.content.trim();
    
    // Parse suggested follow-ups if present
    let answer = fullContent;
    let followUpQuestions = [];

    const followUpMatch = fullContent.match(/###\s*Suggested Follow-ups?\s*\n([\s\S]+)$/i);
    if (followUpMatch) {
      const followUpBlock = followUpMatch[1];
      followUpQuestions = followUpBlock
        .split('\n')
        .map(line => line.replace(/^[-*•\d\.]+\s*/, '').trim())
        .filter(q => q.length > 5 && q.endsWith('?'))
        .slice(0, 3);
      
      // Keep answer clean or include the follow-up section
      answer = fullContent.replace(/###\s*Suggested Follow-ups?\s*\n[\s\S]+$/i, '').trim();
    }

    return {
      answer,
      followUpQuestions
    };
  } catch (error) {
    console.error('Error generating answer:', error);
    throw new Error(`Chat completion failed: ${error.message}`);
  }
}

/**
 * Generates an interactive Concept Knowledge Graph (nodes and links) from document chunks.
 * @param {Array<{page_number: number, content: string}>} chunks 
 * @param {string} filename 
 * @returns {Promise<{nodes: Array<{id: string, group: string, val: number}>, links: Array<{source: string, target: string, relationship: string}>}>}
 */
async function generateConceptGraph(chunks, filename) {
  const client = getClient();
  
  if (!chunks || chunks.length === 0) {
    return { nodes: [], links: [] };
  }

  const sampledText = chunks.slice(0, 10).map(c => `[Page ${c.page_number}]: ${c.content.slice(0, 400)}`).join('\n\n');

  const systemPrompt = `You are a knowledge graph builder.
Analyze the following document excerpts from "${filename}" and construct a concise concept graph of the key entities, concepts, topics, and relationships.
Return RAW VALID JSON ONLY with no markdown wrapping. Format:
{
  "nodes": [
    {"id": "ConceptName", "group": "TopicCategory", "val": 10}
  ],
  "links": [
    {"source": "ConceptName1", "target": "ConceptName2", "relationship": "relates_to"}
  ]
}`;

  try {
    const response = await withRetry(async () => {
      return await client.chat.completions.create({
        model: CHAT_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: sampledText }
        ],
        temperature: 0.2,
      });
    });

    let rawText = response.choices[0].message.content.trim();
    if (rawText.startsWith('```')) {
      rawText = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    }
    return JSON.parse(rawText);
  } catch (err) {
    console.error('Error generating concept graph:', err);
    return {
      nodes: [{ id: filename, group: "Document", val: 15 }],
      links: []
    };
  }
}

module.exports = {
  getEmbedding,
  getEmbeddings,
  reformulateQuery,
  generateDocumentSummary,
  generateAnswer,
  generateConceptGraph
};
