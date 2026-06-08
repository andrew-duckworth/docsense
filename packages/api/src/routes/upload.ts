/*
 * WHAT THIS FILE DOES
 * Handles POST /upload — accepts a PDF or DOCX file via multipart form,
 * runs it through the full ingestion pipeline, and streams progress back
 * to the client as Server-Sent Events so the UI can show a live status bar.
 *
 * WHERE IT FITS IN THE ARCHITECTURE
 * This is the HTTP entry point for ingestion. It connects the outside world
 * to the four-step pipeline in order:
 *   parseFile → chunkDocument → embedChunks → upsertChunks
 * Phase 1 built those four modules; this route wires them together behind an
 * HTTP endpoint for the first time.
 *
 * THE KEY CONCEPT TO UNDERSTAND
 * multer is an Express middleware that handles multipart/form-data — the
 * encoding browsers and curl use when sending files. It reads the raw HTTP
 * body, extracts the file bytes, and hands them to us as req.file.buffer.
 * We use memoryStorage (no disk writes) because the buffer is consumed
 * immediately by parseFile() and we don't want temp files to clean up.
 * This is the same reason you'd use a streaming parser instead of writing
 * a large JSON body to disk before processing it.
 *
 * INTERVIEW TALKING POINT
 * "The upload route streams SSE progress events so the frontend can render
 * a live status bar during ingestion — especially important for the embedding
 * step, which is the slowest part of the pipeline for large documents."
 */

import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { parseFile } from '../ingestion/parser';
import { chunkDocument } from '../ingestion/chunker';
import { embedChunks } from '../ingestion/embedder';
import { ensureCollection, upsertChunks } from '../retrieval/vectorStore';

const router = Router();

// DECISION: memoryStorage keeps the uploaded file in req.file.buffer rather
// than writing it to a temp directory. The buffer is consumed immediately by
// parseFile() so there is nothing to clean up. Trade-off: the full file lives
// in RAM during ingestion — 50 MB limit prevents runaway memory usage.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

// Every SSE event sent during upload has one of these shapes.
type UploadSseEvent =
  | { type: 'progress'; stage: 'parsing' | 'chunking' | 'embedding' | 'storing'; message: string }
  | { type: 'done'; result: { filename: string; chunksCreated: number; characterCount: number } }
  | { type: 'error'; message: string };

function sendEvent(res: Response, event: UploadSseEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// upload.single('file') runs first: it parses the multipart body, populates
// req.file, and enforces the size limit — before our async handler runs.
router.post('/', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file received. POST a multipart form with a field named "file".' });
    return;
  }

  // SSE headers must be set before any pipeline work starts. Once sent, the
  // response is committed — mid-stream errors are sent as SSE error events,
  // not HTTP 4xx/5xx responses (those headers are already gone).
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const { buffer, originalname } = req.file;

  try {
    // ── Step 1: Parse ───────────────────────────────────────────────────────
    sendEvent(res, {
      type: 'progress',
      stage: 'parsing',
      message: `Parsing "${originalname}"…`,
    });

    const parsed = await parseFile(buffer, originalname);

    // ── Step 2: Chunk ───────────────────────────────────────────────────────
    sendEvent(res, {
      type: 'progress',
      stage: 'chunking',
      message: `Splitting ${parsed.characterCount.toLocaleString()} characters into chunks…`,
    });

    const chunks = await chunkDocument(parsed);

    // ── Step 3: Embed ───────────────────────────────────────────────────────
    // This is the slowest step — Ollama processes chunks in batches of 32.
    // The client sees one event here; batch-level progress appears in the
    // server console via the console.log statements in embedder.ts.
    sendEvent(res, {
      type: 'progress',
      stage: 'embedding',
      message: `Embedding ${chunks.length} chunks via Ollama (this may take a moment)…`,
    });

    // Ensure the Qdrant collection exists before embedding, so a first-run
    // failure is caught before we spend time on embedding.
    await ensureCollection();
    const embeddedChunks = await embedChunks(chunks);

    // ── Step 4: Store ───────────────────────────────────────────────────────
    sendEvent(res, {
      type: 'progress',
      stage: 'storing',
      message: `Upserting ${embeddedChunks.length} vectors into Qdrant…`,
    });

    await upsertChunks(embeddedChunks);

    // ── Done ────────────────────────────────────────────────────────────────
    sendEvent(res, {
      type: 'done',
      result: {
        filename: originalname,
        chunksCreated: chunks.length,
        characterCount: parsed.characterCount,
      },
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : 'An unexpected error occurred during ingestion';
    sendEvent(res, { type: 'error', message });
  }

  res.end();
});

export default router;
