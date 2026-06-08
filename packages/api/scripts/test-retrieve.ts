/*
 * WHAT THIS FILE DOES
 * Test script for the retriever. Asks Qdrant for the top matching chunks
 * for a question you type on the command line, then prints the results with
 * scores and source metadata so you can see what the LLM will be given.
 *
 * WHERE IT FITS IN THE ARCHITECTURE
 * This is a dev tool for Phase 2 — not part of the running app.
 * It exercises: embedQuery → Qdrant search → RetrievedChunk[]
 *
 * HOW TO RUN
 * npx tsx scripts/test-retrieve.ts "your question here"
 */

import 'dotenv/config';
import { retrieve } from '../src/retrieval/retriever';

function hr() {
  console.log('─'.repeat(60));
}

async function main() {
  const question = process.argv.slice(2).join(' ');

  if (!question) {
    console.error('Usage: npx tsx scripts/test-retrieve.ts "your question here"');
    process.exit(1);
  }

  console.log('\nDocSense — retrieval test');
  hr();
  console.log(`Question: "${question}"`);
  hr();

  console.log('\nEmbedding question and searching Qdrant...\n');

  const t = Date.now();
  const chunks = await retrieve(question);
  const elapsed = ((Date.now() - t) / 1000).toFixed(2);

  if (chunks.length === 0) {
    console.log('No results returned above the score threshold.');
    console.log('Make sure you have ingested a document first:');
    console.log('  npx tsx scripts/test-ingest.ts path/to/document.pdf');
    return;
  }

  console.log(`Retrieved ${chunks.length} chunks in ${elapsed}s\n`);
  hr();

  chunks.forEach((chunk, i) => {
    console.log(`\nResult ${i + 1} — score: ${chunk.score.toFixed(4)}`);
    console.log(`Source: ${chunk.metadata.filename} (chunk ${chunk.metadata.chunkIndex + 1}/${chunk.metadata.totalChunks})`);
    console.log(`\n${chunk.text.slice(0, 400)}${chunk.text.length > 400 ? '...' : ''}`);
    hr();
  });
}

main().catch((err) => {
  console.error('\nRetrieval failed:', err.message);
  process.exit(1);
});