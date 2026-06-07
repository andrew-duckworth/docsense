/*
 * WHAT THIS FILE DOES
 * End-to-end test script for the ingestion pipeline. Reads a PDF or DOCX from
 * disk and runs it through every stage: parse → chunk → embed → upsert.
 * Prints timing and stats at each step so you can see exactly what's happening.
 *
 * WHERE IT FITS IN THE ARCHITECTURE
 * This is not part of the running application — it's a dev tool to verify the
 * ingestion pipeline works before the Express routes exist.
 *
 * HOW TO RUN
 * npx tsx scripts/test-ingest.ts path/to/document.pdf
 */

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { parseFile } from '../src/ingestion/parser';
import { chunkDocument } from '../src/ingestion/chunker';
import { embedChunks } from '../src/ingestion/embedder';
import { ensureCollection, upsertChunks, getCollectionInfo } from '../src/retrieval/vectorStore';

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://localhost:6333';

function hr() {
  console.log('─'.repeat(60));
}

function elapsed(start: number) {
  return `${((Date.now() - start) / 1000).toFixed(1)}s`;
}

async function main() {
  const filePath = process.argv[2];

  if (!filePath) {
    console.error('Usage: npx tsx scripts/test-ingest.ts <path-to-pdf-or-docx>');
    process.exit(1);
  }

  const absolutePath = path.resolve(filePath);
  const filename = path.basename(absolutePath);

  console.log('\nDocSense — ingestion test');
  hr();
  console.log(`File: ${absolutePath}`);
  console.log(`Qdrant: ${QDRANT_URL}`);
  hr();

  // ── Step 1: Parse ────────────────────────────────────────────────────────
  console.log('\n[1/4] Parsing document...');
  let t = Date.now();

  const buffer = await fs.readFile(absolutePath);
  const parsed = await parseFile(buffer, filename);

  console.log(`  File type : ${parsed.fileType.toUpperCase()}`);
  console.log(`  Characters: ${parsed.characterCount.toLocaleString()}`);
  console.log(`  Preview   : "${parsed.text.slice(0, 120).replace(/\n/g, ' ')}..."`);
  console.log(`  Done in ${elapsed(t)}`);

  // ── Step 2: Chunk ────────────────────────────────────────────────────────
  console.log('\n[2/4] Chunking...');
  t = Date.now();

  const chunks = await chunkDocument(parsed);

  console.log(`  Chunks created: ${chunks.length}`);
  console.log(`  First chunk   : "${chunks[0].text.slice(0, 100).replace(/\n/g, ' ')}..."`);
  console.log(`  Last chunk    : "${chunks.at(-1)!.text.slice(0, 100).replace(/\n/g, ' ')}..."`);
  console.log(`  Done in ${elapsed(t)}`);

  // ── Step 3: Embed ────────────────────────────────────────────────────────
  console.log('\n[3/4] Embedding chunks (calling Ollama)...');
  t = Date.now();

  const embedded = await embedChunks(chunks);

  const dims = embedded[0].embedding.length;
  console.log(`  Vectors created   : ${embedded.length}`);
  console.log(`  Dimensions/vector : ${dims}`);
  console.log(`  Done in ${elapsed(t)}`);

  // ── Step 4: Upsert ───────────────────────────────────────────────────────
  console.log('\n[4/4] Upserting into Qdrant...');
  t = Date.now();

  await ensureCollection();
  await upsertChunks(embedded);

  console.log(`  Done in ${elapsed(t)}`);

  // ── Summary ──────────────────────────────────────────────────────────────
  hr();
  console.log('\nIngestion complete. Collection state:\n');

  const info = await getCollectionInfo();
  const count = info.points_count ?? '(unavailable)';
  const status = info.status;

  console.log(`  Collection : documents`);
  console.log(`  Status     : ${status}`);
  console.log(`  Total points in collection: ${count}`);
  console.log(`\nVerify in Qdrant dashboard → ${QDRANT_URL}/dashboard`);
  console.log('  Collections → documents → Points\n');
}

main().catch((err) => {
  console.error('\nIngestion failed:', err.message);
  process.exit(1);
});
