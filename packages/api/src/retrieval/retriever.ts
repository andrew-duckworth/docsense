/*
 * WHAT THIS FILE DOES
 * Takes a plain-text question, converts it to a vector, and asks Qdrant for
 * the most semantically similar document chunks stored during ingestion.
 *
 * WHERE IT FITS IN THE ARCHITECTURE
 * This is step 1 of the query pipeline — it runs before promptBuilder.ts.
 * User question → embedder.ts → retriever.ts → promptBuilder.ts → llm.ts
 * It is the mirror of the ingestion write path: where vectorStore.ts writes
 * vectors in, retriever.ts reads the nearest ones back out.
 *
 * THE KEY CONCEPT TO UNDERSTAND
 * Qdrant's search doesn't scan every stored vector — it uses an HNSW index
 * (Hierarchical Navigable Small World graph) to find approximate nearest
 * neighbours in sub-linear time. Think of HNSW like a skip-list or B-tree:
 * it builds a multi-layer graph at index time so searches traverse a tiny
 * fraction of the data. The trade-off is "approximate" — it can miss a
 * theoretically closer vector, but in practice recall is >99% and it's
 * orders of magnitude faster than brute-force at scale.
 *
 * INTERVIEW TALKING POINT
 * "Retrieval gives the LLM its working memory for a query — without it the
 * model would have to hallucinate answers from training data rather than
 * reasoning over the actual documents."
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { embedQuery } from '../ingestion/embedder';
import { COLLECTION_NAME } from './vectorStore';

// DECISION: Top-5 is the default retrieval count.
// More chunks = more context for the LLM but higher token cost per query and
// noisier prompts if lower-ranked chunks are only weakly related.
// 5 is a widely-used default; for documents with dense, precise facts (e.g.
// legislation) you might drop to 3; for broad narrative docs, try 7-10.
const DEFAULT_TOP_K = 5;

// DECISION: Score threshold of 0.3 filters out chunks that are barely related.
// Cosine similarity ranges 0–1; chunks scoring below ~0.3 tend to be
// semantically unrelated noise. Without a floor, a question about budgets
// might pull in chunks about population statistics just because they share
// common government-document vocabulary.
// Set to 0 to disable filtering entirely (useful during debugging).
const SCORE_THRESHOLD = 0.3;

export interface RetrievedChunk {
  text: string;
  score: number; // cosine similarity: 0 (unrelated) → 1 (identical meaning)
  metadata: {
    filename: string;
    fileType: string;
    chunkIndex: number;
    totalChunks: number;
  };
}

const client = new QdrantClient({
  url: process.env.QDRANT_URL ?? 'http://localhost:6333',
});

export async function retrieve(
  question: string,
  topK: number = DEFAULT_TOP_K,
): Promise<RetrievedChunk[]> {
  // Step 1: Turn the question into the same vector space the chunks live in.
  // The question and the stored chunks must use the same embedding model or the
  // similarity scores will be meaningless — mismatched models produce vectors
  // in incompatible spaces, like comparing GPS coordinates to zip codes.
  const queryVector = await embedQuery(question);

  // Step 2: Ask Qdrant for the nearest stored vectors.
  const results = await client.search(COLLECTION_NAME, {
    vector: queryVector,
    limit: topK,
    score_threshold: SCORE_THRESHOLD,
    with_payload: true, // include text + metadata in the response, not just the ID
  });

  // Step 3: Map Qdrant's response shape to our clean internal type.
  // The payload fields mirror what vectorStore.ts stored during upsert.
  return results.map((hit) => ({
    text: String(hit.payload?.text ?? ''),
    score: hit.score,
    metadata: {
      filename: String(hit.payload?.filename ?? ''),
      fileType: String(hit.payload?.fileType ?? ''),
      chunkIndex: Number(hit.payload?.chunkIndex ?? 0),
      totalChunks: Number(hit.payload?.totalChunks ?? 0),
    },
  }));
}