/*
 * WHAT THIS FILE DOES
 * End-to-end test of the full query pipeline: retrieve → build prompt → stream answer.
 * Prints the answer token by token so you can see the streaming working.
 *
 * WHERE IT FITS IN THE ARCHITECTURE
 * Dev tool for Phase 2 — not part of the running app.
 *
 * HOW TO RUN
 * npx tsx scripts/test-query.ts "your question here"
 *
 * SWITCH TO CLAUDE
 * LLM_PROVIDER=claude npx tsx scripts/test-query.ts "your question here"
 */

import 'dotenv/config';
import { retrieve } from '../src/retrieval/retriever';
import { buildPrompt } from '../src/generation/promptBuilder';
import { streamAnswer } from '../src/generation/llm';

function hr() {
  console.log('─'.repeat(60));
}

async function main() {
  const question = process.argv.slice(2).join(' ');

  if (!question) {
    console.error('Usage: npx tsx scripts/test-query.ts "your question here"');
    process.exit(1);
  }

  console.log('\nDocSense — full query pipeline test');
  hr();
  console.log(`Question : "${question}"`);
  console.log(`Provider : ${process.env.LLM_PROVIDER ?? 'ollama'}`);
  hr();

  // Step 1: Retrieve
  console.log('\n[1/3] Retrieving relevant chunks...');
  const chunks = await retrieve(question);

  if (chunks.length === 0) {
    console.log('No chunks retrieved. Ingest a document first:');
    console.log('  npx tsx scripts/test-ingest.ts path/to/document.pdf');
    return;
  }

  console.log(`  Found ${chunks.length} chunks (top score: ${chunks[0].score.toFixed(4)})`);

  // Step 2: Build prompt
  console.log('\n[2/3] Building prompt...');
  const prompt = buildPrompt(question, chunks);
  console.log(`  Citations: ${prompt.citations.map((c) => `[${c.citationNumber}] ${c.filename}`).join(', ')}`);

  // Step 3: Stream answer
  console.log('\n[3/3] Streaming answer...\n');
  hr();

  const t = Date.now();
  let totalChars = 0;

  for await (const chunk of streamAnswer(prompt)) {
    process.stdout.write(chunk);
    totalChars += chunk.length;
  }

  const elapsed = ((Date.now() - t) / 1000).toFixed(1);
  console.log('\n');
  hr();
  console.log(`\nDone in ${elapsed}s (${totalChars} chars)`);
  console.log('\nCitation sources:');
  prompt.citations.forEach((c) => {
    console.log(`  [${c.citationNumber}] ${c.filename} — chunk ${c.chunkIndex + 1}/${c.totalChunks} (score: ${c.score.toFixed(3)})`);
  });
}

main().catch((err) => {
  console.error('\nQuery failed:', err.message);
  process.exit(1);
});