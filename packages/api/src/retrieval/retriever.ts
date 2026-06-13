/*
 * WHAT THIS FILE DOES
 * Takes a plain-text question and returns the most relevant document chunks
 * using HYBRID search: semantic vector search (Qdrant) and keyword search
 * (BM25) run in parallel, and their rankings are merged with Reciprocal Rank
 * Fusion. Callers see the exact same retrieve() interface as before — the
 * hybrid machinery is entirely internal.
 *
 * WHERE IT FITS IN THE ARCHITECTURE
 * This is step 1 of the query pipeline — it runs before promptBuilder.ts.
 * User question → embedder.ts ─→ vector search (Qdrant)  ─┐
 *               └→ keywordIndex.ts (BM25) ────────────────┴→ RRF merge → top-K
 * It is the mirror of the ingestion write path: where vectorStore.ts writes
 * vectors in, retriever.ts reads the most relevant chunks back out.
 *
 * THE KEY CONCEPT TO UNDERSTAND
 * Vector search and BM25 fail in opposite ways. Embeddings capture meaning
 * ("retirement income" finds chunks about superannuation) but blur exact
 * tokens — a search for "Section 88AB" or "MSD-2024-117" can rank a vaguely
 * related paragraph above the one containing that literal string. BM25 is the
 * opposite: exact tokens are its whole world, but it will never connect "car"
 * to "automobile". Hybrid search runs both and merges the two ranked lists,
 * so each engine covers the other's blind spot.
 *
 * INTERVIEW TALKING POINT
 * "I merged the two rankings with Reciprocal Rank Fusion rather than score
 * averaging, because cosine similarity (0–1) and BM25 scores (unbounded) live
 * on incompatible scales — RRF only uses each result's RANK, which makes the
 * fusion scale-free and parameter-light."
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { embedQuery } from '../ingestion/embedder';
import { keywordSearch } from './keywordIndex';
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
// Note: this threshold applies to the VECTOR candidate list only. A chunk that
// ranks highly on keywords can still surface through BM25 even if its cosine
// score is low — that "embeddings missed it but the words match exactly" case
// is precisely what hybrid search exists to rescue.
// Set to 0 to disable filtering entirely (useful during debugging).
const SCORE_THRESHOLD = 0.3;

// Each search arm fetches more candidates than the caller asked for, so RRF
// has real overlap to work with. Fusing two 5-item lists barely reorders
// anything; fusing two 20-item lists lets a chunk that is #8 on both lists
// beat a chunk that is #2 on one and absent from the other.
const CANDIDATE_MULTIPLIER = 4;

// DECISION: RRF formula and why it beats weighted averaging here.
// Each chunk's fused score is the sum over both lists of 1 / (k + rank),
// where rank is the chunk's 1-based position in that list (chunks absent
// from a list contribute 0). Weighted averaging of raw scores would force us
// to answer an unanswerable question — "how many BM25 points equal 0.1 of
// cosine?" — and to re-tune that weight whenever the corpus changes. RRF
// sidesteps it by discarding scores entirely and using only rank positions,
// which are always comparable. k=60 is the constant from the original RRF
// paper (Cormack et al., 2009); it dampens the gap between rank 1 and rank 2
// so one engine's top hit can't single-handedly dominate the fusion.
const RRF_K = 60;

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

// Internal record for one candidate during fusion. The Qdrant point ID is the
// join key: a chunk found by both engines merges into one entry whose RRF
// contributions accumulate.
interface FusionCandidate {
  rrfScore: number;
  cosineScore: number | null; // known only if the vector arm saw this chunk
  text: string;
  metadata: RetrievedChunk['metadata'];
}

export async function retrieve(
  question: string,
  topK: number = DEFAULT_TOP_K,
  filterFilenames?: string[],
): Promise<RetrievedChunk[]> {
  const candidateCount = topK * CANDIDATE_MULTIPLIER;

  // Step 1: Turn the question into the same vector space the chunks live in.
  // The question and the stored chunks must use the same embedding model or the
  // similarity scores will be meaningless — mismatched models produce vectors
  // in incompatible spaces, like comparing GPS coordinates to zip codes.
  const queryVector = await embedQuery(question);

  // DECISION: When filterFilenames is provided, both search arms are scoped to
  // only those files. The Qdrant filter restricts vector search server-side
  // (no extra network round-trip — the filter is evaluated during ANN search).
  // The BM25 arm filters client-side after scoring, which keeps IDF weights
  // representative of the full corpus.
  const qdrantFilter =
    filterFilenames && filterFilenames.length > 0
      ? { must: [{ key: 'filename', match: { any: filterFilenames } }] }
      : undefined;

  // Step 2: Run both search arms in parallel — they're independent reads.
  const [vectorHits, keywordHits] = await Promise.all([
    client.search(COLLECTION_NAME, {
      vector: queryVector,
      limit: candidateCount,
      score_threshold: SCORE_THRESHOLD,
      with_payload: true,
      ...(qdrantFilter ? { filter: qdrantFilter } : {}),
    }),
    keywordSearch(question, candidateCount, filterFilenames),
  ]);

  // Step 3: Reciprocal Rank Fusion. Walk each ranked list and add
  // 1 / (RRF_K + rank) to the chunk's fused score. A chunk near the top of
  // both lists accumulates two large contributions and rises to the top.
  const candidates = new Map<string, FusionCandidate>();

  vectorHits.forEach((hit, i) => {
    const id = String(hit.id);
    candidates.set(id, {
      rrfScore: 1 / (RRF_K + (i + 1)),
      cosineScore: hit.score,
      text: String(hit.payload?.text ?? ''),
      metadata: {
        filename: String(hit.payload?.filename ?? ''),
        fileType: String(hit.payload?.fileType ?? ''),
        chunkIndex: Number(hit.payload?.chunkIndex ?? 0),
        totalChunks: Number(hit.payload?.totalChunks ?? 0),
      },
    });
  });

  keywordHits.forEach((hit, i) => {
    const contribution = 1 / (RRF_K + (i + 1));
    const existing = candidates.get(hit.chunk.pointId);
    if (existing) {
      existing.rrfScore += contribution; // found by both engines — strongest signal
    } else {
      candidates.set(hit.chunk.pointId, {
        rrfScore: contribution,
        cosineScore: null, // BM25-only hit; cosine filled in below if it survives
        text: hit.chunk.text,
        metadata: hit.chunk.metadata,
      });
    }
  });

  // Step 4: Keep the topK best-fused candidates.
  const fused = Array.from(candidates.entries())
    .sort(([, a], [, b]) => b.rrfScore - a.rrfScore)
    .slice(0, topK);

  // Step 5: The public contract says `score` is cosine similarity (the UI
  // renders it as a relevance %). Chunks that arrived via BM25 alone never got
  // a cosine score, so fetch their stored vectors and compute it directly —
  // a handful of ID lookups, far cheaper than another search.
  const missingIds = fused.filter(([, c]) => c.cosineScore === null).map(([id]) => id);

  if (missingIds.length > 0) {
    const points = await client.retrieve(COLLECTION_NAME, {
      ids: missingIds,
      with_vector: true,
      with_payload: false,
    });
    for (const point of points) {
      const candidate = candidates.get(String(point.id));
      if (candidate && Array.isArray(point.vector)) {
        candidate.cosineScore = cosineSimilarity(queryVector, point.vector as number[]);
      }
    }
  }

  return fused.map(([, c]) => ({
    text: c.text,
    score: c.cosineScore ?? 0,
    metadata: c.metadata,
  }));
}

// Cosine similarity = dot(a, b) / (|a| * |b|) — the angle between two vectors,
// ignoring magnitude. Qdrant computes this server-side during search; we only
// need it client-side for the few BM25-only chunks that skipped vector search.
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}
