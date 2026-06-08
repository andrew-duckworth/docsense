/*
 * WHAT THIS FILE DOES
 * Handles POST /query — the single HTTP endpoint that powers the Q&A feature.
 * Takes a question, runs the full query pipeline, and streams the answer back
 * to the client as Server-Sent Events (SSE).
 *
 * WHERE IT FITS IN THE ARCHITECTURE
 * This is the HTTP boundary of the query pipeline. It connects the outside world
 * (a curl command, the React frontend, a test script) to the internal chain:
 * retrieve → buildPrompt → streamAnswer
 * It is also the file that produces the citation data the frontend will render.
 *
 * THE KEY CONCEPT TO UNDERSTAND
 * Server-Sent Events (SSE) are a one-way streaming protocol built into HTTP.
 * Instead of sending one JSON blob at the end, the server keeps the connection
 * open and pushes small "events" as they become available. Think of it like
 * a readable stream over a normal HTTP response. Each event is:
 *   data: <json string>\n\n
 * The double newline is the delimiter that tells the client "event is complete".
 * SSE is simpler than WebSockets for one-way server-to-client streaming — it
 * works over plain HTTP/1.1 and reconnects automatically on network drops.
 *
 * INTERVIEW TALKING POINT
 * "I used SSE rather than WebSockets because the Q&A flow is strictly one-way —
 * the server streams tokens to the client. SSE is simpler, works over HTTP/2
 * without extra infrastructure, and the browser's EventSource API handles
 * reconnection automatically."
 */

import { Router, type Request, type Response } from 'express';
import { retrieve } from '../retrieval/retriever';
import { buildPrompt } from '../generation/promptBuilder';
import { streamAnswer } from '../generation/llm';
import type { CitationSource } from '../generation/promptBuilder';

const router = Router();

// The shape of a well-formed request body.
interface QueryRequest {
  question: string;
}

// Every SSE event sent to the client has one of these shapes.
// Using a discriminated union makes the frontend's event handler type-safe.
type SseEvent =
  | { type: 'chunk'; text: string }
  | { type: 'citations'; sources: CitationSource[] }
  | { type: 'error'; message: string }
  | { type: 'done' };

// Helper: write a single SSE event to the response.
// The SSE spec requires "data: <payload>\n\n" — the double newline ends the event.
function sendEvent(res: Response, event: SseEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

router.post('/', async (req: Request, res: Response) => {
  const { question } = req.body as QueryRequest;

  // Input validation — reject empty or missing questions immediately.
  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    res.status(400).json({ error: 'question is required and must be a non-empty string' });
    return;
  }

  // DECISION: SSE headers are set before any pipeline work begins.
  // Once these headers are sent, the response is "committed" — we can no longer
  // change the status code. Errors mid-stream are sent as SSE error events
  // instead of HTTP 500 responses, which is the correct SSE pattern.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Allow the React frontend (served on a different port in dev) to read the stream.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  try {
    // ── Step 1: Retrieve ────────────────────────────────────────────────────
    const chunks = await retrieve(question.trim());

    if (chunks.length === 0) {
      sendEvent(res, {
        type: 'error',
        message: 'No relevant documents found. Try ingesting a document first.',
      });
      sendEvent(res, { type: 'done' });
      res.end();
      return;
    }

    // ── Step 2: Build prompt ────────────────────────────────────────────────
    const prompt = buildPrompt(question.trim(), chunks);

    // ── Step 3: Stream the answer ───────────────────────────────────────────
    // Each chunk from the LLM is forwarded immediately as an SSE event.
    // The frontend renders tokens as they arrive — this is what makes the
    // answer appear "typing" in real time.
    for await (const text of streamAnswer(prompt)) {
      sendEvent(res, { type: 'chunk', text });
    }

    // ── Step 4: Send citations ──────────────────────────────────────────────
    // Sent as a single event after the answer is complete. The frontend uses
    // this to render clickable source references below the answer.
    sendEvent(res, { type: 'citations', sources: prompt.citations });

  } catch (err) {
    const message = err instanceof Error ? err.message : 'An unexpected error occurred';
    sendEvent(res, { type: 'error', message });
  }

  // Always close the stream so the client knows we're done.
  sendEvent(res, { type: 'done' });
  res.end();
});

export default router;
