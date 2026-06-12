/*
 * WHAT THIS FILE DOES
 * Manages the Qdrant vector database: creates the collection on first run,
 * and upserts embedded chunks (vector + text + metadata) as searchable points.
 *
 * WHERE IT FITS IN THE ARCHITECTURE
 * This is the final step of ingestion and the data source for retrieval.
 * embedder.ts → vectorStore.ts  (write path)
 * vectorStore.ts ← retriever.ts (read path, Phase 2)
 *
 * THE KEY CONCEPT TO UNDERSTAND
 * Qdrant stores "points" — each point is a vector plus a payload (arbitrary
 * JSON). Think of it like a database row where the primary index is a vector
 * instead of an integer ID. When you search, Qdrant doesn't scan every row —
 * it uses an HNSW graph index to find the nearest vectors in sub-linear time,
 * the same way a B-tree lets a SQL DB find rows without a full table scan.
 *
 * INTERVIEW TALKING POINT
 * "All document chunks live in one Qdrant collection. Filtering by source
 * document is done via payload filters on the metadata we store alongside
 * each vector — same pattern as adding a WHERE clause to a vector search."
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import crypto from 'crypto';
import { EMBEDDING_DIMENSION } from '../ingestion/embedder';
import type { EmbeddedChunk } from '../ingestion/embedder';

// DECISION: One collection holds all documents, differentiated by the
// `filename` field in each point's payload. The alternative — one collection
// per document — would make cross-document queries impossible and explodes
// the number of collections to manage. Single collection + payload filtering
// is the standard Qdrant pattern.
export const COLLECTION_NAME = 'documents';

// DECISION: Cosine similarity is the distance metric for text embeddings.
// It measures the angle between two vectors, ignoring their magnitude, which
// maps well to semantic relatedness. Dot product is faster but requires
// normalised vectors; Euclidean distance penalises magnitude and tends to
// perform worse on high-dimensional text embeddings.
const DISTANCE_METRIC = 'Cosine';

// DECISION: Upsert in batches of 100 — Qdrant's recommended batch size.
// Smaller = more HTTP round-trips; larger = higher memory pressure per request.
const UPSERT_BATCH_SIZE = 100;

const client = new QdrantClient({
  url: process.env.QDRANT_URL ?? 'http://localhost:6333',
});

// Generates a deterministic UUID from filename + chunkIndex.
// DECISION: Deterministic IDs make ingestion idempotent — re-uploading the
// same document overwrites the existing points rather than creating duplicates.
// A random UUID would be simpler but you'd accumulate stale vectors on re-ingest.
function pointId(filename: string, chunkIndex: number): string {
  const hash = crypto
    .createHash('md5')
    .update(`${filename}:${chunkIndex}`)
    .digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-');
}

export async function ensureCollection(): Promise<void> {
  const { collections } = await client.getCollections();
  const exists = collections.some((c) => c.name === COLLECTION_NAME);

  if (!exists) {
    await client.createCollection(COLLECTION_NAME, {
      vectors: {
        size: EMBEDDING_DIMENSION,
        distance: DISTANCE_METRIC,
      },
    });
    console.log(`Created Qdrant collection "${COLLECTION_NAME}" (${EMBEDDING_DIMENSION} dims, ${DISTANCE_METRIC})`);
  }
}

export async function upsertChunks(chunks: EmbeddedChunk[]): Promise<void> {
  for (let i = 0; i < chunks.length; i += UPSERT_BATCH_SIZE) {
    const batch = chunks.slice(i, i + UPSERT_BATCH_SIZE);

    await client.upsert(COLLECTION_NAME, {
      // DECISION: wait:true makes the upsert synchronous — Qdrant confirms the
      // points are indexed before returning. Without this, querying immediately
      // after ingestion can return 0 results because indexing is still in flight.
      wait: true,
      points: batch.map((chunk) => ({
        id: pointId(chunk.metadata.filename, chunk.metadata.chunkIndex),
        vector: chunk.embedding,
        payload: {
          text: chunk.text,
          filename: chunk.metadata.filename,
          fileType: chunk.metadata.fileType,
          chunkIndex: chunk.metadata.chunkIndex,
          totalChunks: chunk.metadata.totalChunks,
        },
      })),
    });

    const end = Math.min(i + UPSERT_BATCH_SIZE, chunks.length);
    console.log(`  Upserted points ${i + 1}–${end} of ${chunks.length}`);
  }
}

export async function getCollectionInfo() {
  return client.getCollection(COLLECTION_NAME);
}

// Scrolls every point in the collection and aggregates per-document stats.
// Returns the same IngestedDocument shape the upload pipeline produces so the
// frontend can render the sidebar identically whether the data came from a
// fresh upload or a page refresh.
export async function listDocuments(): Promise<{ filename: string; chunksCreated: number; characterCount: number }[]> {
  // Guard: if the collection doesn't exist yet (no documents ingested ever),
  // return an empty list rather than letting the scroll call throw.
  try {
    const { collections } = await client.getCollections();
    if (!collections.some((c) => c.name === COLLECTION_NAME)) return [];
  } catch {
    return [];
  }

  // DECISION: Use Qdrant's scroll API (cursor-based pagination) rather than
  // fetching all points at once. Scroll is safe at any collection size —
  // fetching all points in one request would OOM the client at large scale.
  const docMap = new Map<string, { chunksCreated: number; characterCount: number }>();
  let offset: string | number | Record<string, unknown> | null = null;

  do {
    const result = await client.scroll(COLLECTION_NAME, {
      with_payload: true,
      with_vector: false,
      limit: 250,
      ...(offset !== null ? { offset } : {}),
    });

    for (const point of result.points) {
      const p = point.payload as { filename: string; text: string } | null;
      if (!p?.filename) continue;

      const entry = docMap.get(p.filename);
      if (entry) {
        entry.chunksCreated += 1;
        entry.characterCount += p.text?.length ?? 0;
      } else {
        docMap.set(p.filename, { chunksCreated: 1, characterCount: p.text?.length ?? 0 });
      }
    }

    offset = result.next_page_offset ?? null;
  } while (offset !== null);

  return Array.from(docMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([filename, stats]) => ({ filename, ...stats }));
}
