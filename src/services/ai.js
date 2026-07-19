const { OpenAI } = require('openai');
require('dotenv').config();

const freshApiKey = process.env.OPENAI_API_KEY;

// let openai;
// if (apiKey) {
//   openai = new OpenAI({ apiKey });
// } else {
//   console.warn('WARNING: OPENAI_API_KEY is not defined. AI calls will fail until it is set.');
// }
openai = new OpenAI({
  apiKey: freshApiKey,
  baseURL: 'https://integrate.api.nvidia.com/v1'
});

/**
 * Helper to ensure OpenAI is initialized.
 */
function getClient() {
  if (!openai) {
    const freshApiKey = process.env.OPENAI_API_KEY;
    if (!freshApiKey) {
      throw new Error('OpenAI API Key is missing. Please set OPENAI_API_KEY in the environment.');
    }
    openai = new OpenAI({ 
      apiKey: freshApiKey,
      baseURL: 'https://integrate.api.nvidia.com/v1'
    });
  }
  return openai;
}

/**
 * Generate embedding vector for text.
 * @param {string} text - The input text to embed
 * @returns {Promise<Array<number>>} The 1536-dimension float array
 */
async function getEmbedding(text) {
  const client = getClient();
  try {
    const response = await client.embeddings.create({
      model: 'nvidia/nv-embed-v1',
      input: text.replace(/\n/g, ' '),
    });
    return response.data[0].embedding;
  } catch (error) {
    console.error('Error generating embedding:', error);
    throw new Error(`OpenAI Embedding generation failed: ${error.message}`);
  }
}

/**
 * Generate embedding vectors for an array of texts.
 * @param {Array<string>} texts - The input texts to embed
 * @returns {Promise<Array<Array<number>>>} The list of 1536-dimension float arrays
 */
async function getEmbeddings(texts) {
  const client = getClient();
  try {
    const response = await client.embeddings.create({
      model: 'nvidia/nv-embed-v1',
      input: texts.map(t => t.replace(/\n/g, ' ')),
    });
    return response.data.map(item => item.embedding);
  } catch (error) {
    console.error('Error generating batch embeddings:', error);
    throw new Error(`OpenAI Batch Embedding generation failed: ${error.message}`);
  }
}

/**
 * Answer a question using the retrieved context chunks.
 * @param {string} question - User question
 * @param {Array<{page_number: number, content: string}>} contextChunks - Retrieved relevant document pages/chunks
 * @returns {Promise<string>} The model's answer
 */
async function generateAnswer(question, contextChunks) {
  const client = getClient();

  // Format the retrieved context into a single readable block
  const formattedContext = contextChunks
    .map((chunk, idx) => `[Source ${idx + 1}] (Page ${chunk.page_number}):\n${chunk.content}`)
    .join('\n\n');

  const systemPrompt = `You are a helpful and precise assistant for DocuMind AI.
You are tasked with answering the user's question using ONLY the provided document context below.

Rules:
1. Ground your answer completely in the context.
2. If the context does not contain the answer, say "I'm sorry, but I cannot find that information in the uploaded document." Do not try to make up or deduce information outside of the context.
3. Be concise, professional, and clear.
4. When referring to specific statements, cite the sources by page number (e.g., "[Page 5]").

Context:
${formattedContext}
`;

  try {
    const response = await client.chat.completions.create({
      model: 'meta/llama-3.1-8b-instruct',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question }
      ],
      temperature: 0.1, // low temperature to reduce hallucinations and enforce context compliance
    });

    return response.choices[0].message.content;
  } catch (error) {
    console.error('Error generating answer:', error);
    throw new Error(`OpenAI Chat completion failed: ${error.message}`);
  }
}

module.exports = {
  getEmbedding,
  getEmbeddings,
  generateAnswer
};
