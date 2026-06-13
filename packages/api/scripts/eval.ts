/*
 * WHAT THIS FILE DOES
 * An automated evaluation harness ("eval") for the DocSense RAG system. It uses
 * Claude (claude-opus-4-8) to invent a set of factual question/answer pairs from
 * the documents stored in Qdrant, runs each question through the REAL DocSense
 * query pipeline, and then uses Claude again as an impartial judge to score
 * whether the system's answer was correct and grounded. It prints a results
 * table and a final pass score.
 *
 * WHERE IT FITS IN THE ARCHITECTURE
 * This is a developer/CI tool, not part of the running app. It sits on TOP of
 * the whole query pipeline and exercises it end to end:
 *   (generate Qs) → retrieve → buildPrompt → streamAnswer → (judge answers)
 * Question generation and judging are done with the Claude API; the answers
 * being judged come from the system's own LLM (Ollama by default, or Claude if
 * LLM_PROVIDER=claude), so this measures DocSense as actually configured.
 *
 * THE KEY CONCEPT TO UNDERSTAND
 * This is "LLM-as-a-judge", the standard way to evaluate RAG systems at scale.
 * The hard part of evaluating a Q&A system is that there is no single exact
 * correct string — many phrasings are right. Instead of string-matching, we give
 * a strong model (the judge) the question, a ground-truth reference answer, the
 * source passage, and the system's answer, and ask it to decide PASS/FAIL with a
 * reason. To keep the judge honest, the reference answer is generated FROM a real
 * document passage, so "correct" means "supported by the source", not "sounds
 * plausible". Think of it as automated marking against an answer key, where the
 * answer key was itself written from the textbook.
 *
 * INTERVIEW TALKING POINT
 * "I evaluated the system with an LLM-as-judge harness: Claude generates a
 * reference Q&A set grounded in the source documents, the RAG pipeline answers
 * each question, and Claude scores the answers against the references with
 * structured (schema-constrained) output — so the eval is reproducible, gives a
 * single pass/fail number, and exits non-zero in CI if the system drops below
 * the quality bar."
 */

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { QdrantClient } from '@qdrant/js-client-rest';

import { retrieve } from '../src/retrieval/retriever';
import { buildPrompt } from '../src/generation/promptBuilder';
import { streamAnswer } from '../src/generation/llm';
import { chunkDocument } from '../src/ingestion/chunker';
import { embedChunks } from '../src/ingestion/embedder';
import { ensureCollection, upsertChunks, listDocuments, COLLECTION_NAME } from '../src/retrieval/vectorStore';

// ── Configuration ───────────────────────────────────────────────────────────

// DECISION: claude-opus-4-8 is used for BOTH question generation and judging.
// The eval is only meaningful if the question-writer and judge are at least as
// capable as the system under test — a weak judge would pass weak answers. Opus
// is the strongest available model, so it sets a credible quality bar.
const MODEL = 'claude-opus-4-8';

// DECISION: target 15 questions with a pass bar of 8 (the "8/15" bar from the
// brief). If fewer substantive passages are available than requested, we scale
// both the question count and the bar proportionally so the ratio is preserved.
const TARGET_QUESTIONS = Number(process.env.EVAL_QUESTIONS ?? 15);
const PASS_RATIO = 8 / 15;

// Only chunks with at least this much text make good question sources — tiny
// fragments (page headers, single lines) don't contain a self-contained fact.
const MIN_PASSAGE_CHARS = 350;

// DECISION: government documents are auto-selected by filename keyword. Qdrant
// in this project also holds personal test files (a CV, a receipt); generating
// welfare-policy questions from a résumé would be nonsense. This allowlist keeps
// the eval focused on the NZ-government demo corpus the system is pitched for.
const GOVERNMENT_KEYWORDS = [
  'benefit', 'welfare', 'jobseeker', 'msd', 'budget', 'census',
  'treasury', 'mbie', 'policy', 'settings', 'support',
];

const EVAL_DATA_DIR = path.join(__dirname, 'eval-data');

const QDRANT_URL = process.env.QDRANT_URL ?? 'http://localhost:6333';
const qdrant = new QdrantClient({ url: QDRANT_URL });
const claude = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

// ── Types ───────────────────────────────────────────────────────────────────

interface SourcePassage {
  filename: string;
  chunkIndex: number;
  text: string;
}

interface QAPair {
  question: string;
  referenceAnswer: string;
  source: SourcePassage;
}

interface EvalResult {
  qa: QAPair;
  systemAnswer: string;
  retrievedFrom: string[]; // filenames the retriever pulled context from
  verdict: 'PASS' | 'FAIL';
  score: number; // 1 (wrong) → 5 (fully correct and grounded)
  reasoning: string;
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function hr() {
  console.log('─'.repeat(72));
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : flat.slice(0, n - 1) + '…';
}

/**
 * Calls Claude and parses a schema-constrained JSON object out of the response.
 *
 * DECISION: We use the Messages API structured-outputs feature
 * (output_config.format with a json_schema) rather than asking for JSON in the
 * prompt and hoping. The API then *guarantees* the text block is valid JSON
 * matching the schema, so JSON.parse can't blow up on a stray prose preamble.
 * Adaptive thinking is left on — judging answer quality is a reasoning task, and
 * structured outputs are compatible with extended thinking.
 */
async function claudeJSON<T>(
  system: string,
  user: string,
  schema: Record<string, unknown>,
): Promise<T> {
  const res = await claude.messages.create({
    model: MODEL,
    max_tokens: 3000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema },
    },
    system,
    messages: [{ role: 'user', content: user }],
  });

  // Opus 4.8 can decline a request (HTTP 200, stop_reason "refusal"); check
  // before reading content or we'd parse an empty/partial block.
  if (res.stop_reason === 'refusal') {
    throw new Error('Claude declined the request (stop_reason: refusal).');
  }

  // With thinking on, the response is [thinking…, text]. The schema-constrained
  // JSON lives in the final text block.
  const textBlock = [...res.content]
    .reverse()
    .find((b): b is Anthropic.TextBlock => b.type === 'text');
  if (!textBlock) throw new Error('Claude response contained no text block.');

  return JSON.parse(textBlock.text) as T;
}

// ── Step 0: make sure there is something to evaluate ──────────────────────────

/**
 * Ingests the bundled sample document(s) so the harness is self-contained for
 * anyone who clones the repo with an empty Qdrant. Reads .txt files from
 * scripts/eval-data/, chunks → embeds → upserts them, reusing the real pipeline.
 */
async function ingestBundledSamples(): Promise<void> {
  let files: string[] = [];
  try {
    files = (await fs.readdir(EVAL_DATA_DIR)).filter((f) => f.endsWith('.txt'));
  } catch {
    /* directory missing — fall through to the empty check below */
  }
  if (files.length === 0) {
    throw new Error(
      `Qdrant is empty and no bundled sample documents were found in ${EVAL_DATA_DIR}. ` +
        `Add a .txt (or ingest a PDF via scripts/test-ingest.ts) and re-run.`,
    );
  }

  await ensureCollection();

  for (const file of files) {
    const text = await fs.readFile(path.join(EVAL_DATA_DIR, file), 'utf-8');
    // The bundled samples are plain text, so we build a ParseResult-shaped object
    // directly and skip parser.ts (which only decodes PDF/DOCX binaries).
    const chunks = await chunkDocument({
      text,
      filename: file,
      fileType: 'pdf', // stored as metadata only; the demo corpus is PDFs
      characterCount: text.length,
    });
    console.log(`  Ingesting "${file}" → ${chunks.length} chunks…`);
    const embedded = await embedChunks(chunks);
    await upsertChunks(embedded);
  }
}

/** Pulls every chunk's text out of Qdrant (one scroll pass over the collection). */
async function loadAllPassages(): Promise<SourcePassage[]> {
  const passages: SourcePassage[] = [];
  let offset: string | number | Record<string, unknown> | null = null;

  do {
    const result = await qdrant.scroll(COLLECTION_NAME, {
      with_payload: true,
      with_vector: false,
      limit: 250,
      ...(offset !== null ? { offset } : {}),
    });
    for (const point of result.points) {
      const p = point.payload as { text?: string; filename?: string; chunkIndex?: number } | null;
      if (!p?.text || !p.filename) continue;
      passages.push({
        filename: String(p.filename),
        chunkIndex: Number(p.chunkIndex ?? 0),
        text: p.text,
      });
    }
    offset = result.next_page_offset ?? null;
  } while (offset !== null);

  return passages;
}

/**
 * Picks the documents to evaluate against and returns evenly-spread source
 * passages from them. Government docs are preferred; if none match (e.g. a fresh
 * clone with only the bundled sample), every document is used.
 */
function selectPassages(all: SourcePassage[], howMany: number): SourcePassage[] {
  const substantive = all.filter((p) => p.text.length >= MIN_PASSAGE_CHARS);

  const looksGovernment = (fn: string) =>
    GOVERNMENT_KEYWORDS.some((k) => fn.toLowerCase().includes(k));

  const govPassages = substantive.filter((p) => looksGovernment(p.filename));
  const pool = govPassages.length > 0 ? govPassages : substantive;

  // Sort by document then position so the even-spacing pick spreads questions
  // across files and across each file, rather than clustering on one section.
  pool.sort((a, b) =>
    a.filename === b.filename ? a.chunkIndex - b.chunkIndex : a.filename.localeCompare(b.filename),
  );

  if (pool.length <= howMany) return pool;

  // Even-spaced sampling across the sorted pool.
  const step = pool.length / howMany;
  const picked: SourcePassage[] = [];
  for (let i = 0; i < howMany; i++) {
    picked.push(pool[Math.floor(i * step)]);
  }
  return picked;
}

// ── Step 1: generate the reference Q&A set ────────────────────────────────────

const GEN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    question: { type: 'string' },
    reference_answer: { type: 'string' },
  },
  required: ['question', 'reference_answer'],
};

const GEN_SYSTEM = `You are building an evaluation set for a document question-answering system used on New Zealand government policy documents.

Given one passage from a document, write:
1. "question": ONE specific, factual question a real user might ask, that is fully answerable from this passage alone. Make it self-contained — do NOT say "according to the passage" or "in this document". Prefer concrete facts (numbers, criteria, definitions, rules) over vague themes.
2. "reference_answer": the correct, concise answer, grounded strictly in the passage.

Do not invent facts that are not in the passage.`;

async function generateQA(passage: SourcePassage): Promise<QAPair> {
  const out = await claudeJSON<{ question: string; reference_answer: string }>(
    GEN_SYSTEM,
    `Passage (from "${passage.filename}"):\n\n${passage.text}`,
    GEN_SCHEMA,
  );
  return {
    question: out.question.trim(),
    referenceAnswer: out.reference_answer.trim(),
    source: passage,
  };
}

// ── Step 2: run a question through the real DocSense pipeline ──────────────────

async function answerWithSystem(question: string): Promise<{ answer: string; retrievedFrom: string[] }> {
  const chunks = await retrieve(question);
  if (chunks.length === 0) {
    return { answer: '(no chunks retrieved)', retrievedFrom: [] };
  }
  const prompt = buildPrompt(question, chunks);

  let answer = '';
  for await (const piece of streamAnswer(prompt)) answer += piece;

  const retrievedFrom = [...new Set(chunks.map((c) => c.metadata.filename))];
  return { answer: answer.trim(), retrievedFrom };
}

// ── Step 3: judge the system answer ───────────────────────────────────────────

const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    score: { type: 'integer', enum: [1, 2, 3, 4, 5] },
    reasoning: { type: 'string' },
  },
  required: ['verdict', 'score', 'reasoning'],
};

const JUDGE_SYSTEM = `You are a strict but fair evaluator of a document question-answering (RAG) system.

You are given a QUESTION, a REFERENCE ANSWER (ground truth, written from the source passage), the SOURCE PASSAGE, and the SYSTEM ANSWER produced by the system being tested.

Decide whether the SYSTEM ANSWER is correct:
- "verdict": "PASS" if the system answer is factually correct and supported by the source passage / reference answer, even if worded differently or more briefly. "FAIL" if it is wrong, contradicts the source, omits the key fact the question asked for, or claims it lacks the information when the reference answer shows the information was available.
- "score": 1 = completely wrong or no answer; 3 = partially correct or missing detail; 5 = fully correct and well-grounded.
- "reasoning": one or two sentences explaining the verdict. Be specific about what was right or wrong.

Judge correctness, not style or verbosity.`;

async function judge(qa: QAPair, systemAnswer: string): Promise<{ verdict: 'PASS' | 'FAIL'; score: number; reasoning: string }> {
  const user = [
    `QUESTION:\n${qa.question}`,
    `REFERENCE ANSWER:\n${qa.referenceAnswer}`,
    `SOURCE PASSAGE (from "${qa.source.filename}"):\n${qa.source.text}`,
    `SYSTEM ANSWER:\n${systemAnswer}`,
  ].join('\n\n');

  return claudeJSON(JUDGE_SYSTEM, user, JUDGE_SCHEMA);
}

// ── Orchestration ─────────────────────────────────────────────────────────────

async function main() {
  console.log('\nDocSense — evaluation harness (LLM-as-judge)');
  hr();

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      'ERROR: ANTHROPIC_API_KEY is not set. The eval uses the Claude API to\n' +
        'generate questions and judge answers. Set it and re-run:\n' +
        '  PowerShell:  $env:ANTHROPIC_API_KEY="sk-ant-..."; npm run eval --workspace=packages/api\n' +
        '  bash:        ANTHROPIC_API_KEY=sk-ant-... npm run eval --workspace=packages/api',
    );
    process.exit(1);
  }

  const provider = process.env.LLM_PROVIDER ?? 'ollama';
  console.log(`Judge / generator : ${MODEL} (Claude API)`);
  console.log(`System under test : DocSense pipeline, answers via ${provider}`);
  console.log(`Qdrant            : ${QDRANT_URL}`);
  hr();

  // Step 0: ensure the corpus exists.
  let docs = await listDocuments();
  if (docs.length === 0) {
    console.log('\nQdrant is empty — ingesting bundled sample document(s)…');
    await ingestBundledSamples();
    docs = await listDocuments();
  }
  console.log(`\nCorpus: ${docs.length} document(s) in Qdrant.`);

  const allPassages = await loadAllPassages();
  const passages = selectPassages(allPassages, TARGET_QUESTIONS);
  if (passages.length === 0) {
    console.error('No substantive passages found to generate questions from. Ingest a document first.');
    process.exit(1);
  }

  const evalDocs = [...new Set(passages.map((p) => p.filename))];
  console.log(`Generating ${passages.length} question(s) from ${evalDocs.length} document(s):`);
  evalDocs.forEach((d) => console.log(`  • ${d}`));

  // Step 1: generate the Q&A set.
  hr();
  console.log('\n[1/3] Generating reference Q&A pairs with Claude…');
  const qaPairs: QAPair[] = [];
  for (let i = 0; i < passages.length; i++) {
    try {
      const qa = await generateQA(passages[i]);
      qaPairs.push(qa);
      console.log(`  ✓ Q${i + 1}: ${truncate(qa.question, 80)}`);
    } catch (err) {
      console.log(`  ✗ Q${i + 1} generation failed: ${(err as Error).message}`);
    }
  }

  // Steps 2 & 3: answer each question with the system, then judge it.
  hr();
  console.log('\n[2/3] Answering with the DocSense pipeline + [3/3] judging…\n');
  const results: EvalResult[] = [];
  for (let i = 0; i < qaPairs.length; i++) {
    const qa = qaPairs[i];
    process.stdout.write(`  Q${i + 1}/${qaPairs.length} answering… `);
    const { answer, retrievedFrom } = await answerWithSystem(qa.question);
    process.stdout.write('judging… ');
    const verdict = await judge(qa, answer);
    console.log(`${verdict.verdict} (${verdict.score}/5)`);
    results.push({ qa, systemAnswer: answer, retrievedFrom, ...verdict });
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  hr();
  console.log('\nRESULTS\n');

  results.forEach((r, i) => {
    console.log(`Q${i + 1}. [${r.verdict} ${r.score}/5]  ${r.qa.question}`);
    console.log(`     source     : ${r.qa.source.filename}`);
    console.log(`     retrieved  : ${r.retrievedFrom.join(', ') || '(none)'}`);
    console.log(`     reference  : ${truncate(r.qa.referenceAnswer, 160)}`);
    console.log(`     system     : ${truncate(r.systemAnswer, 160)}`);
    console.log(`     judge       : ${truncate(r.reasoning, 200)}`);
    console.log('');
  });

  // Compact summary table.
  hr();
  console.log('\nSUMMARY TABLE\n');
  console.log(`  ${'#'.padEnd(4)}${'VERDICT'.padEnd(9)}${'SCORE'.padEnd(7)}QUESTION`);
  results.forEach((r, i) => {
    console.log(
      `  ${String(i + 1).padEnd(4)}${r.verdict.padEnd(9)}${`${r.score}/5`.padEnd(7)}${truncate(r.qa.question, 52)}`,
    );
  });

  const passed = results.filter((r) => r.verdict === 'PASS').length;
  const total = results.length;
  const bar = Math.max(1, Math.ceil(PASS_RATIO * total));
  const avgScore = total ? (results.reduce((s, r) => s + r.score, 0) / total).toFixed(2) : '0';

  hr();
  console.log(`\nFINAL SCORE: ${passed}/${total} passed  (avg quality ${avgScore}/5)`);
  console.log(`Minimum bar: ${bar}/${total}  (scaled from 8/15)`);
  if (passed >= bar) {
    console.log(`✅ PASS — the system met the quality bar.\n`);
    process.exitCode = 0;
  } else {
    console.log(`❌ BELOW BAR — investigate retrieval/generation before moving on.\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('\nEval failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
