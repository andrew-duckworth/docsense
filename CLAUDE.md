# CLAUDE.md — DocSense
### RAG Document Intelligence System

---

## Who is building this

My name is Andrew. I'm a full-stack developer with a strong Node.js and React background. I'm building this project to land a Forward Deployed Engineer role in Wellington, NZ. The RAG/vector DB/embeddings concepts in this stack are new to me, so I need you to help me understand what you're building as you build it — not just produce code.

---

## How I want you to work with me

**This is the most important section. Follow these rules on every file you create or modify.**

### 1. Add an explanation block to every file

At the top of every file you create, before any imports or code, add a comment block in this format:

```
/*
 * WHAT THIS FILE DOES
 * One or two plain sentences describing the file's job in the system.
 *
 * WHERE IT FITS IN THE ARCHITECTURE
 * Which step of the pipeline is this? (e.g. "This is step 2 of ingestion —
 * it runs after the PDF is parsed and before embeddings are created.")
 *
 * THE KEY CONCEPT TO UNDERSTAND
 * One thing a Node.js developer with no RAG background would need to
 * understand to read, modify, or debug this file confidently.
 *
 * INTERVIEW TALKING POINT
 * One sentence I can say in an interview to show I understand this module.
 */
```

### 2. Explain new concepts in Node.js terms

I know Express, REST APIs, async/await, databases (SQL and NoSQL), and React. When you introduce something unfamiliar (embeddings, vector search, cosine similarity, chunking strategies, etc.), explain it using analogies to things I already know. For example: "A vector database is like a regular database, except instead of querying by exact field values, you query by similarity — think of it like a `findSimilar()` instead of a `findById()`."

### 3. Tell me when a decision matters

When you make an architectural decision that I might get asked about in an interview — chunk size, embedding model choice, vector DB selection, similarity metric — flag it with a `// DECISION:` comment explaining the trade-off in plain terms. Example:

```ts
// DECISION: Chunk size is set to 512 tokens with 50-token overlap.
// Smaller chunks = more precise retrieval but lose surrounding context.
// Larger chunks = more context but noisier search results.
// 512 is a safe default for policy documents; tune this based on document type.
```

### 4. One phase at a time

Only build what's in the current phase. Don't scaffold the whole project upfront. I want to understand each layer before we add the next one.

### 5. After each phase, give me a checkpoint

When a phase is complete, output a short summary:
- What was built
- How to test it works (a curl command, a test script, or steps to verify in the browser)
- The one concept from this phase I should be able to explain before we move on

---

## Project Overview

**DocSense** is a RAG-powered document Q&A system. The elevator pitch for interviews:

> *"I built a document intelligence deployment for a government policy context — ingesting PDF and Word documents, chunking and embedding them into a local vector store, and surfacing answers with source citations via a conversational interface. The system runs fully on-premises with no external API dependency, which was a hard requirement for the client environment."*

---

## Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Ingestion | `pdf-parse` + `mammoth` | Parse PDF + DOCX natively in Node.js |
| Chunking | LangChain.js `RecursiveCharacterTextSplitter` | Battle-tested overlap chunking |
| Embeddings | `nomic-embed-text` via Ollama | Runs locally on a 4070 Ti, no API cost, no data leaves the machine |
| Vector DB | Qdrant (Docker) | Self-hosted, production-grade, meets NZ government data sovereignty requirements |
| LLM | `qwen2.5:14b` via Ollama (local) with Claude API as fallback | Local-first for dev; swap to Claude for demos |
| API | Express + TypeScript | Familiar, clean, easy to explain |
| Frontend | React + Vite | Familiar territory |

**Why local over cloud (important interview answer):** Qdrant + Ollama means no document data leaves the local network. For NZ government clients (MSD, MBIE, Corrections), this is often a hard requirement, not a preference.

---

## Architecture

```
INGESTION PIPELINE
──────────────────
Upload (PDF/DOCX)
  → Parse to plain text         [parser.ts]
  → Split into chunks            [chunker.ts]
  → Convert chunks to vectors    [embedder.ts]
  → Store vectors in Qdrant      [vectorStore.ts]

QUERY PIPELINE
──────────────
User question (text)
  → Convert question to vector   [embedder.ts]
  → Find similar chunks          [retriever.ts]
  → Build prompt with context    [promptBuilder.ts]
  → Send to LLM                  [llm.ts]
  → Return answer + citations    [query route]
```

---

## Project Structure

```
docsense/
├── CLAUDE.md                       ← you are here
├── docker-compose.yml              ← Qdrant + Ollama
├── packages/
│   ├── api/                        ← Express + TypeScript backend
│   │   ├── src/
│   │   │   ├── ingestion/
│   │   │   │   ├── parser.ts       ← PDF/DOCX → raw text
│   │   │   │   ├── chunker.ts      ← raw text → chunks
│   │   │   │   └── embedder.ts     ← chunks → vectors (via Ollama)
│   │   │   ├── retrieval/
│   │   │   │   ├── vectorStore.ts  ← Qdrant client (store + search)
│   │   │   │   └── retriever.ts    ← similarity search wrapper
│   │   │   ├── generation/
│   │   │   │   ├── promptBuilder.ts ← assembles context + question into a prompt
│   │   │   │   └── llm.ts          ← calls Ollama or Claude API
│   │   │   └── routes/
│   │   │       ├── upload.ts       ← POST /upload
│   │   │       └── query.ts        ← POST /query
│   │   └── index.ts
│   └── web/                        ← React + Vite frontend
│       └── src/
│           ├── components/
│           │   ├── DocumentUploader.tsx
│           │   ├── ChatInterface.tsx
│           │   └── CitationPanel.tsx
│           └── App.tsx
```

---

## Build Phases

### Phase 1 — Ingestion Pipeline
Build the pipeline from file upload to vectors stored in Qdrant. No frontend yet — test everything with scripts or curl.

- [ ] `docker-compose.yml` with Qdrant and Ollama services
- [ ] `parser.ts` — extract plain text from PDF and DOCX
- [ ] `chunker.ts` — split text into overlapping chunks with metadata (filename, page)
- [ ] `embedder.ts` — convert chunks to vectors via Ollama `nomic-embed-text`
- [ ] `vectorStore.ts` — create Qdrant collection, upsert vectors
- [ ] Test: ingest one document and confirm chunks appear in Qdrant dashboard

### Phase 2 — Query Pipeline
Wire up retrieval and generation. Still no frontend — test with curl or a test script.

- [ ] `retriever.ts` — embed a question, search Qdrant, return top-5 chunks
- [ ] `promptBuilder.ts` — inject retrieved chunks into a prompt template with citation markers
- [ ] `llm.ts` — send prompt to Ollama (qwen2.5:14b), stream the response
- [ ] `query.ts` route — POST /query → returns answer + source citations
- [ ] Test: ask a question about the ingested document, get an answer with citations

### Phase 3 — Express API + Frontend
Expose the pipeline via API and build the UI.

- [ ] `upload.ts` route — POST /upload, triggers full ingestion pipeline
- [ ] Streaming via SSE so the answer appears word by word
- [ ] React frontend: drag-and-drop uploader with ingestion progress
- [ ] Chat interface with message history
- [ ] Citation panel — click a citation to see the exact source chunk

### Phase 4 — Polish (FDE differentiators)
These are the things that show depth in interviews.
Complete and test each task fully before moving to the next.
Push to GitHub after each task. Stop and report when done.

- [ ] Task 4.1 — Document persistence: Add GET /documents endpoint
      that queries Qdrant for all unique filenames currently stored.
      Frontend calls this on startup so the sidebar reflects actual
      Qdrant state, not just the current session.
      IMPLEMENTATION NOTE: DocumentUploader.tsx IS the sidebar — it
      renders on the left with the document list already built in.
      No new component needed. Checkbox selection (Task 4.3) goes
      into the existing document list inside DocumentUploader.

- [ ] Task 4.2 — Hybrid search: Combine BM25 keyword search with
      existing vector search. Merge results using Reciprocal Rank
      Fusion (RRF). The retriever.ts interface must not change —
      hybrid logic is internal only.
      IMPLEMENTATION NOTE: Use an in-memory BM25 library (e.g.
      wink-bm25-text-search). Do NOT use Qdrant sparse vectors —
      that would require re-ingesting all documents.
      DECISION comment to include: "Chose in-memory BM25 over Qdrant
      sparse vectors because it requires no re-ingestion, and at the
      document scale this system targets the performance difference is
      negligible. The trade-off: sparse vectors would be faster at
      100k+ chunks; in-memory BM25 is the right call below that."
      Also add a DECISION comment explaining the RRF formula and why
      it was chosen over weighted averaging.

- [ ] Task 4.3 — Multi-document queries: Add checkbox selection to
      the document sidebar (requires Task 4.1). Checkboxes go inside
      the existing DocumentUploader component — no new sidebar needed.
      Pass selected filenames to POST /query. Retrieval layer filters
      Qdrant by selected documents. Prompt template instructs LLM to
      compare and contrast when multiple documents are selected.

- [ ] Task 4.4 — Eval harness: Script at scripts/eval.ts that runs
      10-15 test Q&A pairs against the NZ government PDFs. Use the
      Claude API with model claude-opus-4-8 to generate test questions
      automatically and evaluate answer quality. Output a results table
      and final score. Minimum bar: 8/15 before moving on.
      IMPLEMENTATION NOTE: Check Qdrant first (http://localhost:6333/dashboard).
      If NZ government PDFs are present from earlier testing, use them.
      If Qdrant is empty, the harness must ingest its own test documents
      as part of setup so the script is self-contained for anyone who
      clones the repo.

- [ ] Task 4.5 — README and deploy: Full README.md using the structure
      defined at the bottom of this file. Include architecture diagram,
      quick start, design decisions, eval results table, and what I'd
      add with more time. Must be clear enough for a Palantir or
      Datacom hiring manager to understand both what it does and why
      every decision was made.
      EVAL RESULTS: 14/15 passed, avg quality 4.80/5. One failure: 
      retrieval returned wrong chunk type for a list question — BM25 
      keyword boost ranked Emergency Housing Special Needs Grants 
      higher than Benefit Advances. Fix: reranker or increased top-K.

---

## Demo Dataset

Load these publicly available NZ government documents — instantly relatable to Wellington interviewers:

- **stats.govt.nz** — census methodology PDFs
- **treasury.govt.nz** — Budget documents
- **msd.govt.nz** — policy and welfare guides
- **MBIE** — regulatory guidance documents

Good demo questions to prepare:
- *"What is the eligibility criteria for jobseeker support?"*
- *"Summarise the key fiscal risks in the 2024 Budget."*
- *"What does the census say about Wellington population growth?"*

---

## Interview Prep — Key Questions to Be Able to Answer

By the end of this project you should be able to answer these confidently:

**On chunking:**
- Why do we split documents into chunks at all?
- What is chunk overlap and why does it help?
- How would you choose a different chunk size for a different document type?

**On embeddings:**
- What is a vector embedding in plain English?
- Why does `nomic-embed-text` work for this instead of a general-purpose LLM?

**On vector search:**
- What is cosine similarity and how is it different from a SQL WHERE clause?
- What is the difference between vector search and keyword search, and when would you use each?

**On the overall system:**
- What happens if the LLM hallucinates something not in the documents?
- How would you evaluate whether this system is giving good answers?
- What would you change to scale this to 10,000 documents?

---

## README Structure (write this last)

```markdown
## DocSense

RAG-powered document intelligence, deployable on-premises.

### Architecture
[diagram]

### Quick Start
docker-compose up -d
npm install && npm run dev

### Design Decisions
- Why Qdrant over Pinecone: data sovereignty, self-hosted
- Chunking strategy: 512 tokens, 50 overlap — why
- Embedding model: nomic-embed-text — local, no data egress

### Evaluation
[table: test question | expected answer | system answer | pass/fail]

### What I'd add with more time
- Reranker (Cohere or cross-encoder)
- Async ingestion queue
- Role-based document access controls
```
