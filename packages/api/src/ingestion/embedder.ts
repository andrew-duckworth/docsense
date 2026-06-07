/*
 * WHAT THIS FILE DOES
 * Sends text to Ollama's nomic-embed-text model and receives back a vector —
 * an array of 768 numbers that encodes the semantic meaning of that text.
 * Used in both ingestion (embedding chunks) and querying (embedding questions).
 *
 * WHERE IT FITS IN THE ARCHITECTURE
 * Ingestion: chunker.ts → embedder.ts → vectorStore.ts
 * Query:     user question → embedder.ts → retriever.ts
 * It sits at the junction of both pipelines — same function, different caller.
 *
 * THE KEY CONCEPT TO UNDERSTAND
 * An embedding is a "meaning fingerprint". Two sentences that mean the same
 * thing produce vectors that point in nearly the same direction in 768-
 * dimensional space, even if they share zero words in common. This is what
 * makes semantic search work — you're matching meaning, not keywords.
 * Think of it like hashing, except similar inputs produce similar outputs
 * (the exact opposite behaviour of a cryptographic hash like SHA-256).
 *
 * INTERVIEW TALKING POINT
 * "nomic-embed-text runs entirely via Ollama on local hardware — embeddings
 * are generated on the machine, so no document text ever leaves the network."
 */

import ollama from 'ollama';
import type { Chunk } from './chunker';

export interface EmbeddedChunk {
  text: string;
  embedding: number[];
  metadata: Chunk['metadata'];
}

// DECISION: nomic-embed-text produces 768-dimension vectors.
// This constant is exported so vectorStore.ts can use it when creating the
// Qdrant collection — the collection's vector size must match exactly or
// upserts will be rejected. If you switch embedding models, change this.
export const EMBEDDING_DIMENSION = 768;

// DECISION: Ollama model name is defined once here, not scattered across files.
// To swap embedding models (e.g. to mxbai-embed-large at 1024 dims), change
// this and EMBEDDING_DIMENSION together.
const EMBED_MODEL = 'nomic-embed-text';

// DECISION: Chunks are sent to Ollama in batches of 32, not one at a time.
// A single HTTP round-trip per chunk would be slow for large documents
// (200 chunks = 200 sequential HTTP calls). Batching amortises that overhead.
// 32 is conservative — nomic-embed-text can handle larger batches, but this
// keeps memory pressure low on the Ollama side.
const BATCH_SIZE = 32;

async function embedBatch(texts: string[]): Promise<number[][]> {
  const response = await ollama.embed({
    model: EMBED_MODEL,
    input: texts,
  });
  return response.embeddings;
}

export async function embedChunks(chunks: Chunk[]): Promise<EmbeddedChunk[]> {
  const results: EmbeddedChunk[] = [];

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map((c) => c.text);

    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(chunks.length / BATCH_SIZE);
    console.log(`  Embedding batch ${batchNum}/${totalBatches} (${batch.length} chunks)...`);

    const embeddings = await embedBatch(texts);

    for (let j = 0; j < batch.length; j++) {
      results.push({
        text: batch[j].text,
        embedding: embeddings[j],
        metadata: batch[j].metadata,
      });
    }
  }

  return results;
}

// Embeds a single string — used by the query pipeline to vectorise a question.
// Kept separate from embedChunks so the query route doesn't need to construct
// a fake Chunk object just to call this.
export async function embedQuery(question: string): Promise<number[]> {
  const response = await ollama.embed({
    model: EMBED_MODEL,
    input: question,
  });
  return response.embeddings[0];
}
