/*
 * WHAT THIS FILE DOES
 * Takes a user question and the retrieved chunks from Qdrant and assembles
 * them into a structured prompt that tells the LLM exactly what to say and
 * where its facts are coming from. Also produces a citations map so the
 * frontend can show which source backed each part of the answer.
 *
 * WHERE IT FITS IN THE ARCHITECTURE
 * This is step 2 of the query pipeline — it runs after retrieval and before
 * the LLM call. retriever.ts → promptBuilder.ts → llm.ts
 * Think of it as writing the "brief" you hand to a researcher: here are the
 * relevant documents, here is the question, answer only from these documents.
 *
 * THE KEY CONCEPT TO UNDERSTAND
 * Prompt engineering is the primary lever for controlling LLM behaviour in a
 * RAG system. The system prompt is a contract — it tells the model the rules
 * of the game. "Answer only from context" is a grounding instruction that
 * dramatically reduces hallucination by giving the model an explicit out
 * ("I don't have enough information") instead of encouraging it to fill gaps
 * with training-data guesses. Without this, the LLM treats retrieved chunks
 * as hints, not as the exclusive source of truth.
 *
 * INTERVIEW TALKING POINT
 * "By numbering each context chunk and instructing the model to cite [N]
 * markers, I get structured citations back that map directly to source
 * documents — the frontend can render clickable references without any
 * post-processing regex on the LLM's response."
 */

import type { RetrievedChunk } from '../retrieval/retriever';

export interface CitationSource {
  citationNumber: number; // the [N] number that appears in the LLM's answer
  filename: string;
  chunkIndex: number;
  totalChunks: number;
  score: number; // cosine similarity — useful for debugging, not shown to users
  text: string;  // the raw chunk text, shown in the citation panel on click
}

export interface BuiltPrompt {
  systemPrompt: string;
  userMessage: string;
  citations: CitationSource[]; // parallel to the [1], [2], ... markers in the prompt
}

// DECISION: System prompt and user message are kept separate, not concatenated.
// Chat-oriented LLMs (like qwen2.5 and Claude) have a system/user/assistant
// turn structure. Splitting them correctly gives the model the right framing —
// the system prompt sets the persona and rules; the user message is the actual
// query. Concatenating them into one string loses that distinction and often
// produces worse output.
const SYSTEM_PROMPT = `You are a document assistant. Your job is to answer questions using only the context provided below.

Rules:
- Base your answer exclusively on the provided context. Do not use outside knowledge.
- If the answer is not present in the context, say: "I don't have enough information in the provided documents to answer that."
- Cite your sources using [1], [2], etc. notation inline as you write your answer.
- Be concise and direct. Prefer bullet points for multi-part answers.
- Do not fabricate quotes or invent details not present in the context.`;

export function buildPrompt(
  question: string,
  chunks: RetrievedChunk[],
): BuiltPrompt {
  // DECISION: Chunks are renumbered [1]–[N] here regardless of their Qdrant
  // rank order. The LLM doesn't need to know about cosine scores — it just
  // needs clean, labelled reference numbers it can cite in its response.
  const citations: CitationSource[] = chunks.map((chunk, i) => ({
    citationNumber: i + 1,
    filename: chunk.metadata.filename,
    chunkIndex: chunk.metadata.chunkIndex,
    totalChunks: chunk.metadata.totalChunks,
    score: chunk.score,
    text: chunk.text,
  }));

  // Build the context block that gets injected into the user message.
  // Each chunk is labelled with its citation number and source file so the
  // model can reference both in its answer.
  const contextBlock = citations
    .map(
      (c) =>
        `[${c.citationNumber}] Source: ${c.filename} (chunk ${c.chunkIndex + 1} of ${c.totalChunks})\n${c.text}`,
    )
    .join('\n\n');

  // DECISION: The question comes after the context, not before it.
  // Studies on LLM attention show models better follow instructions and stay
  // grounded when context precedes the question — the model "reads the docs"
  // before seeing what it's being asked, rather than priming itself on the
  // question first and then selectively scanning the context to confirm a
  // pre-formed answer.
  const userMessage = `Context:\n\n${contextBlock}\n\n---\n\nQuestion: ${question}\n\nAnswer (cite sources using [1], [2], etc.):`;

  return {
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
    citations,
  };
}
