/*
 * WHAT THIS FILE DOES
 * Maintains an in-memory BM25 keyword index over every chunk stored in Qdrant,
 * and exposes a keywordSearch() function that ranks chunks by exact-word
 * relevance — the classic "search engine" scoring, as opposed to the semantic
 * similarity that vector search provides.
 *
 * WHERE IT FITS IN THE ARCHITECTURE
 * This is one half of the hybrid retrieval introduced in Task 4.2. It sits
 * beside vectorStore.ts as a second, parallel read path over the same data:
 *   retriever.ts → vector search (Qdrant)  ─┐
 *   retriever.ts → keywordSearch (this file)─┴→ RRF merge → top-K chunks
 * It reads chunk text out of Qdrant at startup (lazily, on first query) and
 * never writes anything — Qdrant remains the single source of truth.
 *
 * THE KEY CONCEPT TO UNDERSTAND
 * BM25 is the algorithm behind classic full-text search (it's what
 * Elasticsearch uses by default). It scores a chunk by counting how often the
 * query's words literally appear in it, weighted by how rare each word is
 * across the whole collection — a chunk containing the rare term "jobseeker"
 * twice beats a chunk containing the common word "support" five times. Think
 * of it as SQL's LIKE '%word%' upgraded with statistics about word rarity and
 * document length. It knows nothing about meaning: "car" will never match
 * "automobile". That blindness is exactly what vector search covers, which is
 * why we run both.
 *
 * INTERVIEW TALKING POINT
 * "Vector search can miss exact identifiers — section numbers, acronyms,
 * proper nouns — because embeddings smooth them into general meaning. The
 * BM25 index catches those literal matches, and RRF in the retriever merges
 * both rankings without having to compare their incompatible score scales."
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import bm25Factory from 'wink-bm25-text-search';
import nlp from 'wink-nlp-utils';
import { COLLECTION_NAME } from './vectorStore';

// The chunk data we keep in memory alongside the BM25 index, so a keyword hit
// can be returned with full text + metadata without a second Qdrant round-trip.
export interface IndexedChunk {
  pointId: string; // the Qdrant point ID — the join key for merging with vector hits
  text: string;
  metadata: {
    filename: string;
    fileType: string;
    chunkIndex: number;
    totalChunks: number;
  };
}

export interface KeywordHit {
  chunk: IndexedChunk;
  score: number; // raw BM25 score — unbounded, NOT comparable to cosine similarity
}

const client = new QdrantClient({
  url: process.env.QDRANT_URL ?? 'http://localhost:6333',
});

// DECISION: Chose in-memory BM25 over Qdrant sparse vectors because it
// requires no re-ingestion, and at the document scale this system targets the
// performance difference is negligible. The trade-off: sparse vectors would be
// faster at 100k+ chunks; in-memory BM25 is the right call below that.

// The cached index, plus the exact Qdrant point count at the moment it was
// built. Before every search we re-check the count: if a document was uploaded
// (or the collection wiped) since the last build, the counts differ and we
// rebuild. This keeps the index in sync without the upload route having to
// know this file exists — the same lazy-invalidation pattern as an HTTP cache
// with an ETag check.
let cache: {
  engine: ReturnType<typeof bm25Factory>;
  chunks: IndexedChunk[];
  pointCount: number;
} | null = null;

// wink-bm25 refuses to consolidate() an index with fewer than 3 documents.
// Below that size the retriever silently falls back to pure vector search.
const MIN_DOCS_FOR_BM25 = 3;

async function exactPointCount(): Promise<number> {
  const { collections } = await client.getCollections();
  if (!collections.some((c) => c.name === COLLECTION_NAME)) return 0;
  const { count } = await client.count(COLLECTION_NAME, { exact: true });
  return count;
}

// Scrolls every chunk's text out of Qdrant and builds a fresh BM25 index.
// Cost is one pass over the collection — fine at this system's scale, and it
// only happens when the collection actually changed (see cache check above).
async function buildIndex(pointCount: number): Promise<typeof cache> {
  const chunks: IndexedChunk[] = [];
  // The scroll cursor can be a string, number, or (for UUID point IDs) an
  // object — mirror the client library's own type for next_page_offset.
  let offset: string | number | Record<string, unknown> | null = null;

  do {
    const result = await client.scroll(COLLECTION_NAME, {
      with_payload: true,
      with_vector: false, // we only need text — vectors stay in Qdrant
      limit: 250,
      ...(offset !== null ? { offset } : {}),
    });

    for (const point of result.points) {
      const p = point.payload as {
        text?: string;
        filename?: string;
        fileType?: string;
        chunkIndex?: number;
        totalChunks?: number;
      } | null;
      if (!p?.text) continue;

      chunks.push({
        pointId: String(point.id),
        text: p.text,
        metadata: {
          filename: String(p.filename ?? ''),
          fileType: String(p.fileType ?? ''),
          chunkIndex: Number(p.chunkIndex ?? 0),
          totalChunks: Number(p.totalChunks ?? 0),
        },
      });
    }

    offset = result.next_page_offset ?? null;
  } while (offset !== null);

  if (chunks.length < MIN_DOCS_FOR_BM25) {
    return { engine: bm25Factory(), chunks: [], pointCount };
  }

  // A consolidated wink-bm25 engine is immutable (addDoc throws after
  // consolidate), so every rebuild starts from a fresh engine instance.
  const engine = bm25Factory();
  engine.defineConfig({ fldWeights: { text: 1 } });

  // The prep pipeline normalises text before indexing AND queries before
  // searching — both sides must go through the same steps or tokens won't
  // match. lowercase → tokenize → drop stop words → stem, so that
  // "Funding", "funded" and "funds" all become the same token "fund".
  engine.definePrepTasks([
    nlp.string.lowerCase,
    nlp.string.removeExtraSpaces,
    nlp.string.tokenize0,
    nlp.tokens.removeWords,
    nlp.tokens.stem,
  ]);

  chunks.forEach((chunk, i) => {
    // The numeric uniqueId is the array index — search() hands it back and we
    // use it to look the chunk up again in O(1).
    engine.addDoc({ text: chunk.text }, i);
  });

  engine.consolidate();
  console.log(`BM25 index built: ${chunks.length} chunks from Qdrant`);

  return { engine, chunks, pointCount };
}

/**
 * Ranks stored chunks by BM25 keyword relevance to the question.
 * Returns an empty array when the collection is too small to index —
 * callers treat that as "no keyword signal" and rely on vector search alone.
 */
export async function keywordSearch(question: string, limit: number): Promise<KeywordHit[]> {
  const pointCount = await exactPointCount();
  if (pointCount === 0) return [];

  if (!cache || cache.pointCount !== pointCount) {
    cache = await buildIndex(pointCount);
  }
  if (cache!.chunks.length === 0) return [];

  // search() can throw if the prep pipeline reduces the query to zero tokens
  // (e.g. a question made entirely of stop words like "what is it about").
  // That's a legitimate "no keyword signal" case, not an error.
  try {
    const results = cache!.engine.search(question, limit);
    return results.map(([docIndex, score]) => ({
      chunk: cache!.chunks[docIndex],
      score,
    }));
  } catch {
    return [];
  }
}
