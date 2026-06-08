/*
 * WHAT THIS FILE DOES
 * Sends the assembled prompt to an LLM and streams the response back as an
 * async generator of text chunks. Ollama (local qwen2.5:14b) is the primary
 * provider; the Claude API is the fallback for demos or when Ollama is down.
 *
 * WHERE IT FITS IN THE ARCHITECTURE
 * This is the final step of the query pipeline.
 * promptBuilder.ts → llm.ts → query route (Phase 3)
 * The caller iterates the returned async generator and forwards each chunk to
 * the HTTP response via SSE — that's what makes the answer appear word by word.
 *
 * THE KEY CONCEPT TO UNDERSTAND
 * Streaming works because modern LLMs generate tokens sequentially. Instead of
 * waiting for the whole answer, the API sends each token as soon as it's ready.
 * An async generator (`yield`) is the idiomatic Node.js way to produce a sequence
 * of values over time — it's like an array whose items arrive asynchronously.
 * Think of it as a readable stream, but with `for await...of` instead of `.on('data')`.
 *
 * INTERVIEW TALKING POINT
 * "The LLM layer is swappable via an environment variable — Ollama for local
 * development (no data egress, no API cost), Claude for client demos where
 * you need reliability and a polished model. The interface is identical either
 * way, so the route code doesn't change."
 */

import Anthropic from '@anthropic-ai/sdk';
import ollama from 'ollama';
import type { BuiltPrompt } from './promptBuilder';

// DECISION: qwen2.5:14b is the local default.
// It fits comfortably in VRAM on a 4070 Ti and performs well on
// instruction-following tasks like RAG Q&A. The 14b parameter count is
// the sweet spot between quality and inference speed for this use case.
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'qwen2.5:14b';

// DECISION: claude-sonnet-4-6 is the Claude fallback.
// It's the best balance of speed and intelligence in the current Claude lineup —
// fast enough for interactive chat, smart enough for nuanced document Q&A.
// claude-opus-4-8 would give higher quality but at ~5x the cost per token.
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-6';

// DECISION: 2048 tokens for max output.
// RAG answers should be concise — the retrieved context is the substance;
// the LLM's job is to synthesise it, not pad it out. 2048 is generous for
// a well-scoped Q&A answer while keeping latency and cost in check.
const MAX_TOKENS = 2048;

// DECISION: Provider is selected via LLM_PROVIDER env var, defaulting to Ollama.
// This lets you run `LLM_PROVIDER=claude` in a demo environment without changing
// any code. Both providers expose the same streaming generator interface to callers.
type Provider = 'ollama' | 'claude';
const PROVIDER: Provider = (process.env.LLM_PROVIDER as Provider) ?? 'ollama';

async function* streamOllama(prompt: BuiltPrompt): AsyncGenerator<string> {
  const stream = await ollama.chat({
    model: OLLAMA_MODEL,
    messages: [
      { role: 'system', content: prompt.systemPrompt },
      { role: 'user', content: prompt.userMessage },
    ],
    stream: true,
  });

  for await (const chunk of stream) {
    const text = chunk.message.content;
    if (text) yield text;
  }
}

async function* streamClaude(prompt: BuiltPrompt): AsyncGenerator<string> {
  // DECISION: The Anthropic client reads ANTHROPIC_API_KEY from the environment
  // automatically — no need to pass it explicitly. This keeps the key out of code.
  const client = new Anthropic();

  const stream = client.messages.stream({
    model: CLAUDE_MODEL,
    max_tokens: MAX_TOKENS,
    system: prompt.systemPrompt,
    messages: [{ role: 'user', content: prompt.userMessage }],
  });

  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      yield event.delta.text;
    }
  }
}

// The public interface: one function, two providers, same caller contract.
// The query route calls this and streams each yielded chunk to the client.
export async function* streamAnswer(prompt: BuiltPrompt): AsyncGenerator<string> {
  if (PROVIDER === 'claude') {
    yield* streamClaude(prompt);
  } else {
    yield* streamOllama(prompt);
  }
}