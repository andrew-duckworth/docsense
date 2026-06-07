/*
 * WHAT THIS FILE DOES
 * Takes the plain text from parser.ts and splits it into smaller, overlapping
 * segments called chunks, each tagged with metadata about its source document.
 *
 * WHERE IT FITS IN THE ARCHITECTURE
 * This is step 2 of the ingestion pipeline — it runs after parsing and before
 * embedding. parser.ts → chunker.ts → embedder.ts → vectorStore.ts
 *
 * THE KEY CONCEPT TO UNDERSTAND
 * You can't embed an entire document as one vector — the embedding model has a
 * token limit, and a single vector for a 50-page PDF would lose all the detail.
 * Chunking is like cutting a book into index cards: each card is small enough
 * to embed precisely, and the overlap between cards means a sentence that falls
 * near a boundary isn't lost. Think of it as pagination for the AI pipeline.
 *
 * INTERVIEW TALKING POINT
 * "RecursiveCharacterTextSplitter tries paragraph breaks first, then line
 * breaks, then word boundaries — so chunks split at natural language seams
 * rather than mid-sentence wherever possible."
 */

import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import type { ParseResult } from './parser';

export interface Chunk {
  text: string;
  metadata: {
    filename: string;
    fileType: 'pdf' | 'docx';
    chunkIndex: number;
    totalChunks: number;   // filled in after all chunks are created
  };
}

// DECISION: Chunk size is 1000 characters with 150-character overlap.
// 1000 chars ≈ 250 tokens on average (4 chars/token), well inside nomic-embed-text's
// 8192-token context window and small enough to give precise retrieval results.
// Overlap of 150 chars means a sentence near a chunk boundary is fully present
// in at least one chunk — without overlap, a key fact split across two chunks
// could be missed by the similarity search entirely.
// Tune: go larger (2000 chars) for narrative/policy docs where context matters;
// go smaller (500 chars) for structured data like tables or legislation.
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 150;

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: CHUNK_SIZE,
  chunkOverlap: CHUNK_OVERLAP,
  // DECISION: These separators are tried in order — paragraph breaks first,
  // then line breaks, then spaces, then individual characters as a last resort.
  // This "recursive" fallback is why the class has its name.
  separators: ['\n\n', '\n', ' ', ''],
});

export async function chunkDocument(parsed: ParseResult): Promise<Chunk[]> {
  const texts = await splitter.splitText(parsed.text);

  const totalChunks = texts.length;

  return texts.map((text, index) => ({
    text,
    metadata: {
      filename: parsed.filename,
      fileType: parsed.fileType,
      chunkIndex: index,
      totalChunks,
    },
  }));
}
