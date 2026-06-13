# DocSense

**RAG-powered document intelligence, deployable on-premises.**

> *"I built a document intelligence system for a government policy context — ingesting PDF and Word documents, chunking and embedding them into a local vector store, and surfacing answers with source citations via a conversational interface. The system runs fully on-premises with no external API dependency, which was a hard requirement for the client environment."*

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
  → Find similar chunks          [retriever.ts]  ← hybrid: vector + BM25 + RRF
  → Build prompt with context    [promptBuilder.ts]
  → Send to LLM                  [llm.ts]         ← Ollama local / Claude API
  → Return answer + citations    [query route]
```

```
┌─────────────────────────────────────────────────────────┐
│                        DocSense UI                       │
│  ┌────────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │  Document      │  │    Chat      │  │  Citation   │ │
│  │  Sidebar       │  │  Interface   │  │   Panel     │ │
│  │                │  │              │  │             │ │
│  │ ☑ budget.pdf   │  │ Q: What are  │  │ [1] Source: │ │
│  │ ☑ msd-guide   │  │ the fiscal   │  │ budget.pdf  │ │
│  │ ☐ census.pdf   │  │ risks?       │  │ chunk 4/22  │ │
│  │                │  │ A: The main  │  │             │ │
│  │ [Upload]       │  │ risks are…   │  │ "The risks  │ │
│  │                │  │ [1][2]       │  │ include…"   │ │
│  └────────────────┘  └──────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────────┘
         │                    │
    Express API          Express API
    POST /upload         POST /query (SSE)
    GET /documents
         │                    │
    ┌────▼────────────────────▼────┐
    │       Express + TypeScript    │
    └──────────┬────────────────────┘
               │
    ┌──────────▼───────────────────────────────────┐
    │  Docker Compose                               │
    │  ┌───────────────┐   ┌──────────────────┐    │
    │  │  Qdrant        │   │  Ollama           │    │
    │  │  (vector DB)   │   │  nomic-embed-text │    │
    │  │  port 6333     │   │  qwen2.5:14b      │    │
    │  └───────────────┘   │  port 11434       │    │
    │                       └──────────────────┘    │
    └──────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Ingestion | `pdf-parse` + `mammoth` | Parse PDF + DOCX natively in Node.js |
| Chunking | LangChain.js `RecursiveCharacterTextSplitter` | Battle-tested overlap chunking |
| Embeddings | `nomic-embed-text` via Ollama | Runs locally, no API cost, no data egress |
| Vector DB | Qdrant (Docker) | Self-hosted, production-grade, data sovereignty |
| Keyword index | `wink-bm25-text-search` (in-memory) | Hybrid search without re-ingestion |
| LLM | `qwen2.5:14b` via Ollama / Claude API fallback | Local-first, cloud-fallback for demos |
| API | Express + TypeScript | Familiar, clean |
| Frontend | React + Vite | Three-panel UI with SSE streaming |

---

## Quick Start

### Prerequisites

- Docker Desktop (WSL2 backend on Windows)
- Node.js 18+
- NVIDIA GPU recommended (NVIDIA Container Toolkit for Docker GPU passthrough)
- An `ANTHROPIC_API_KEY` if you want to use Claude as the LLM or run the eval harness

### 1. Start the infrastructure

```bash
docker compose up -d
```

This starts Qdrant (port 6333) and Ollama (port 11434). Verify at:
- Qdrant dashboard: http://localhost:6333/dashboard
- Ollama health: http://localhost:11434

### 2. Pull the models

```bash
# From inside the Ollama container (or via Docker exec):
docker exec -it docsense-ollama ollama pull nomic-embed-text
docker exec -it docsense-ollama ollama pull qwen2.5:14b
```

`nomic-embed-text` is ~274 MB. `qwen2.5:14b` is ~9 GB — allow time on first pull.

### 3. Install dependencies

```bash
npm install
```

### 4. Configure environment

Create `packages/api/.env`:

```env
# Required to use Claude as the LLM or to run the eval harness
ANTHROPIC_API_KEY=sk-ant-...

# Switch to Claude for the answer LLM (optional — Ollama is the default)
# LLM_PROVIDER=claude
```

### 5. Start the servers

```bash
# Terminal 1 — API (port 3001)
npm run dev:api

# Terminal 2 — Frontend (port 5173)
npm run dev:web
```

Open http://localhost:5173

### 6. Use it

1. Drag and drop a PDF or DOCX onto the sidebar
2. Wait for the ingestion progress bar to complete
3. Type a question in the chat box
4. Click any `[1]` citation marker to read the source chunk

---

## Design Decisions

### Why Qdrant over Pinecone or Weaviate

Qdrant runs self-hosted via Docker. For NZ government clients (MSD, MBIE, Corrections), data sovereignty is often a hard requirement: documents must not leave the local network. Qdrant + Ollama means no document text ever touches a cloud provider. Pinecone is SaaS-only; Weaviate is viable but heavier to operate.

### Chunking strategy: 1000 characters, 150 overlap

The `RecursiveCharacterTextSplitter` splits at paragraph boundaries first, then line breaks, then spaces — chunks split at natural language seams rather than mid-sentence wherever possible.

1000 characters ≈ 250 tokens, well inside `nomic-embed-text`'s 8192-token context window. The 150-character overlap ensures a sentence near a chunk boundary is fully present in at least one chunk — without overlap, a key fact split across two chunks could be missed entirely by similarity search.

For legislation or dense tables, reducing to 500 characters gives more precise retrieval. For narrative policy documents where surrounding context matters, 2000 characters is a reasonable upper bound.

### Embedding model: nomic-embed-text

768-dimension vectors. Runs entirely via Ollama — embeddings are generated on the local machine. A critical property: the same model must embed both chunks at ingest time and questions at query time. Mismatched models produce vectors in incompatible spaces.

### Hybrid search: BM25 + vector + RRF

Vector search and BM25 fail in opposite ways:
- **Embeddings** capture meaning ("retirement income" finds superannuation chunks) but blur exact tokens — a search for "Section 88AB" might rank a vaguely related paragraph above the one containing that literal string.
- **BM25** scores on exact word matches, weighted by how rare each word is across the corpus. It will never connect "car" to "automobile", but it excels at acronyms, section numbers, and proper nouns.

Hybrid search runs both in parallel and merges the ranked lists using **Reciprocal Rank Fusion (RRF)**. The formula is: for each result, add `1 / (k + rank)` from each list (k=60, from Cormack et al. 2009). RRF uses only rank positions, not raw scores — this sidesteps the incompatible scale problem (cosine similarity is 0–1; BM25 scores are unbounded) without requiring a manually tuned weight.

In-memory BM25 was chosen over Qdrant sparse vectors because it requires no re-ingestion. At the chunk scale this system targets, the performance difference is negligible. Qdrant sparse vectors would be faster above ~100k chunks.

### LLM selection

`qwen2.5:14b` runs at ~40 tokens/second on a 4070 Ti with GPU passthrough. The 14b parameter count is the sweet spot between quality and inference speed for RAG Q&A.

Claude (`claude-sonnet-4-6`) is the cloud fallback, switchable via `LLM_PROVIDER=claude`. The interface is identical either way — the route code does not change.

### Idempotent ingestion

Each chunk is stored in Qdrant with a deterministic UUID derived from `filename:chunkIndex`. Re-uploading the same document overwrites existing points rather than creating duplicates. A random UUID would be simpler but would accumulate stale vectors on every re-ingest.

### Prompt design

The system prompt is a grounding contract: "Answer exclusively from the provided context." Without this, the LLM treats retrieved chunks as hints and fills gaps from training data (hallucination). Giving the model an explicit out — "I don't have enough information" — dramatically reduces fabrication.

The question comes *after* the context in the user message. Research on LLM attention shows models stay more grounded when they "read the documents" before seeing the question, rather than scanning for confirmation of a pre-formed answer.

Multi-document queries get an additional instruction to compare and contrast across sources. This is appended only when multiple documents are selected — adding it to every query wastes tokens looking for differences that don't exist.

### Streaming via SSE

Server-Sent Events rather than WebSockets because the Q&A flow is strictly one-way. SSE works over plain HTTP/1.1, the browser's `EventSource` API handles reconnection automatically, and it doesn't require a persistent socket handshake. The frontend receives three event types: `chunk` (one per LLM token), `citations` (sent after the answer completes), and `done`.

---

## Evaluation

The eval harness (`scripts/eval.ts`) uses **LLM-as-judge**: Claude generates a reference Q&A set grounded in source passages, DocSense answers each question via the full pipeline, and Claude scores each answer against the reference on a 1–5 scale with a PASS/FAIL verdict.

The judge is `claude-opus-4-8` (the strongest available model). The reference answers are generated *from real document passages*, so "correct" means "supported by the source" — not "sounds plausible". Questions are spread evenly across documents and across positions within each document.

### Results (NZ government policy corpus)

Run against a Jobseeker Support policy sample (MSD-style welfare guidance):

| # | Verdict | Score | Question |
|---|---------|-------|----------|
| 1 | PASS | 5/5 | What is the minimum age to qualify for Jobseeker Support? |
| 2 | PASS | 5/5 | What residency requirement must a person meet to receive Jobseeker Support? |
| 3 | PASS | 5/5 | How many hours of paid work per week constitutes full-time employment? |
| 4 | PASS | 5/5 | What work obligations do most Jobseeker Support recipients have? |
| 5 | PASS | 5/5 | What is the weekly income threshold before a single recipient's payment abates? |
| 6 | PASS | 5/5 | By how many cents does the weekly payment reduce for each dollar earned above the threshold? |
| 7 | PASS | 5/5 | What can happen if a recipient fails to meet work obligations without good reason? |
| 8 | PASS | 5/5 | Under what condition may work obligations be deferred? |
| 9 | PASS | 5/5 | What replaced the former Unemployment Benefit and Sickness Benefit? |
| 10 | PASS | 5/5 | Are partnered recipients assessed on individual or household income? |
| 11 | PASS | 5/5 | What types of steps must a recipient take to meet work obligations? |
| 12 | PASS | 5/5 | What is the definition of Jobseeker Support in terms of employment status? |
| 13 | PASS | 5/5 | Are people aged 19 with dependent children eligible for Jobseeker Support? |
| 14 | PASS | 5/5 | What is the primary purpose of the document described as a sample reference? |
| 15 | FAIL | 2/5 | What exact dollar threshold applies to asset-tested liquid funds? |

**Final score: 14/15 passed — average quality 4.80/5**
Minimum bar: 8/15. System exceeded it with 14/15.

The single failure (Q15) reflects a retrieval gap: the specific dollar threshold for the liquid asset test appeared in a chunk that ranked below the top-5 cutoff. A higher `topK` or a lower `SCORE_THRESHOLD` would recover it at the cost of noisier prompts.

To run the eval yourself:

```bash
# Ensure Qdrant and Ollama are running, then:
ANTHROPIC_API_KEY=sk-ant-... npm run eval --workspace=packages/api
```

The script is self-contained: if Qdrant is empty it ingests the bundled sample document automatically.

---

## What I'd Add With More Time

**Reranker** — A cross-encoder reranker (Cohere Rerank or a local `ms-marco-MiniLM` model) reads each (question, chunk) pair and scores true semantic relevance rather than just proximity. Cross-encoders significantly improve precision at the cost of latency. The current architecture makes this easy to slot in between `retriever.ts` and `promptBuilder.ts`.

**Async ingestion queue** — Large documents block the upload response for the duration of embedding. A job queue (BullMQ + Redis, or a simple in-memory queue with SSE polling) would let the frontend poll for progress rather than holding a long-lived SSE connection.

**Role-based document access** — In a real government deployment, different teams should only retrieve from documents they're authorised to read. Qdrant's payload filters make this straightforward: add a `tenantId` or `accessGroup` field to each point and apply a `must` filter on every search. Authentication middleware (JWT or OAuth) would gate the filter value.

**Chunking by semantic section** — The current splitter cuts at character count. For structured documents (legislation, policy with numbered sections), splitting at section headings first would produce chunks that are semantically complete units, improving both retrieval precision and citation quality.

**Streaming ingestion progress at chunk level** — The current implementation sends one SSE event per pipeline stage. Wiring `embedder.ts` batch callbacks into the SSE stream would let the frontend show a real percentage bar during the embedding step.

---

## Project Structure

```
docsense/
├── docker-compose.yml              ← Qdrant + Ollama
├── packages/
│   ├── api/                        ← Express + TypeScript backend
│   │   ├── src/
│   │   │   ├── ingestion/
│   │   │   │   ├── parser.ts       ← PDF/DOCX → raw text
│   │   │   │   ├── chunker.ts      ← raw text → overlapping chunks
│   │   │   │   └── embedder.ts     ← chunks → 768-dim vectors (Ollama)
│   │   │   ├── retrieval/
│   │   │   │   ├── vectorStore.ts  ← Qdrant client (store + search + list)
│   │   │   │   ├── keywordIndex.ts ← in-memory BM25 index
│   │   │   │   └── retriever.ts    ← hybrid search + RRF merge
│   │   │   ├── generation/
│   │   │   │   ├── promptBuilder.ts ← context + question → structured prompt
│   │   │   │   └── llm.ts          ← streaming LLM (Ollama or Claude)
│   │   │   └── routes/
│   │   │       ├── upload.ts       ← POST /upload (SSE progress)
│   │   │       ├── query.ts        ← POST /query (SSE streaming answer)
│   │   │       └── documents.ts    ← GET /documents (Qdrant state)
│   │   └── scripts/
│   │       ├── eval.ts             ← LLM-as-judge eval harness
│   │       └── eval-data/          ← bundled sample document (MSD-style)
│   └── web/                        ← React + Vite frontend
│       └── src/
│           ├── App.tsx             ← three-panel layout, global state
│           └── components/
│               ├── DocumentUploader.tsx  ← sidebar: upload + checkbox selection
│               ├── ChatInterface.tsx     ← chat history + SSE streaming
│               └── CitationPanel.tsx     ← source chunk viewer
```

---

## API Reference

```
POST /upload
  Content-Type: multipart/form-data
  Body: file (PDF or DOCX, max 50 MB)
  Response: SSE stream — progress events then { type: "done", result: { filename, chunksCreated, characterCount } }

POST /query
  Content-Type: application/json
  Body: { "question": "...", "filterFilenames": ["budget.pdf"] }
  Response: SSE stream — chunk events (tokens), citations event, done event

GET /documents
  Response: { "documents": [{ "filename", "chunksCreated", "characterCount" }] }
```

---

## Demo Questions

Good questions to ask against NZ government documents:

- *"What is the eligibility criteria for Jobseeker Support?"*
- *"Summarise the key fiscal risks in the 2024 Budget."*
- *"What does the census say about Wellington population growth?"*
- *"What are the work obligations for benefit recipients?"*
- *"Compare the income thresholds across the welfare documents."* (select multiple documents)
