/*
 * WHAT THIS FILE DOES
 * Exposes GET /documents — returns the list of all documents currently stored
 * in Qdrant so the frontend can populate the sidebar on page load, not just
 * after a fresh upload in the current session.
 *
 * WHERE IT FITS IN THE ARCHITECTURE
 * This is a read-only query route that sits alongside upload.ts and query.ts.
 * It talks to vectorStore.ts (the Qdrant layer) but bypasses the full retrieval
 * pipeline — it scrolls point metadata, not vectors.
 *
 * THE KEY CONCEPT TO UNDERSTAND
 * Qdrant has no dedicated "list documents" API because it thinks in terms of
 * points, not files. We recover the document list by scrolling all point
 * payloads and aggregating by filename — the same metadata we stored during
 * ingestion. This is efficient because we skip vector data (with_vector: false).
 *
 * INTERVIEW TALKING POINT
 * "Document persistence was a deliberate design choice — the sidebar reflects
 * actual Qdrant state, not just the current browser session, so the system is
 * useful across restarts without re-ingesting documents."
 */

import { Router } from 'express';
import { listDocuments } from '../retrieval/vectorStore';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const documents = await listDocuments();
    res.json({ documents });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to list documents';
    res.status(500).json({ error: message });
  }
});

export default router;
