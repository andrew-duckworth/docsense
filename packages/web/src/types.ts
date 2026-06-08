/*
 * WHAT THIS FILE DOES
 * Central TypeScript type definitions shared across all frontend components.
 * The CitationSource type mirrors the shape sent by the API's /query endpoint
 * so the frontend stays in sync with the backend without duplication.
 *
 * WHERE IT FITS IN THE ARCHITECTURE
 * These types flow through every component. CitationSource starts in the API
 * (promptBuilder.ts), travels over the SSE wire as JSON, and lands here for
 * the React components to consume. Keeping them in one file means a schema
 * change only needs updating in two places: the API and this file.
 *
 * THE KEY CONCEPT TO UNDERSTAND
 * TypeScript's discriminated union (the `phase` field in UploadStatus) is the
 * same pattern as a state machine. Each `phase` value unlocks specific fields:
 * only the 'uploading' phase has `stage` and `message`. This makes impossible
 * states unrepresentable — you can't accidentally read `stage` when `phase`
 * is 'idle' because the type doesn't allow it.
 *
 * INTERVIEW TALKING POINT
 * "Sharing types between the UI state machine and the API wire format meant I
 * caught three schema mismatches at compile time that would have been silent
 * runtime bugs."
 */

// Mirrors CitationSource from packages/api/src/generation/promptBuilder.ts
export interface CitationSource {
  citationNumber: number; // the [N] number the LLM writes in its answer
  filename: string;
  chunkIndex: number;
  totalChunks: number;
  score: number;          // cosine similarity 0–1, shown as a relevance %
  text: string;           // raw chunk text displayed in the citation panel
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  citations?: CitationSource[];
  isStreaming?: boolean;
}

export interface IngestedDocument {
  filename: string;
  chunksCreated: number;
  characterCount: number;
}

export type UploadStage = 'parsing' | 'chunking' | 'embedding' | 'storing';

export type UploadStatus =
  | { phase: 'idle' }
  | { phase: 'uploading'; stage: UploadStage; message: string }
  | { phase: 'done'; document: IngestedDocument }
  | { phase: 'error'; message: string };
