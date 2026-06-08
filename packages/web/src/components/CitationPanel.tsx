/*
 * WHAT THIS FILE DOES
 * Renders the right-side citation panel. When a user clicks a [1] badge in
 * an AI response, this panel slides into view showing the exact source chunk
 * that supported that part of the answer.
 *
 * WHERE IT FITS IN THE ARCHITECTURE
 * This is the "show your work" layer of the RAG system. It receives the active
 * CitationSource from App.tsx (which received it from ChatInterface via a
 * callback), and renders the raw chunk text, filename, position, and relevance
 * score. It exists to make the system auditable — a key requirement for
 * government document contexts.
 *
 * THE KEY CONCEPT TO UNDERSTAND
 * The `score` field is cosine similarity from Qdrant — a number between 0 and 1.
 * We display it as a percentage ("87% relevant") so a non-technical stakeholder
 * can judge whether the LLM was working from a highly relevant source or a
 * marginal one. A score below ~60% often indicates the retrieval step found
 * no truly relevant content and is grasping.
 *
 * INTERVIEW TALKING POINT
 * "Every answer is traceable to a specific chunk from a specific document.
 * A stakeholder can click any citation and read the exact text the LLM saw —
 * this is what differentiates a trustworthy RAG system from a chatbot that
 * might hallucinate."
 */

import type { CitationSource } from '../types';

interface Props {
  citation: CitationSource;
  onClose: () => void;
}

export function CitationPanel({ citation, onClose }: Props) {
  const relevancePct = Math.round(citation.score * 100);

  // Score bar width is clamped: below 50% looks bad in a demo, so we floor
  // the visual at 10% to keep the bar visible even for lower-scored results.
  const barWidth = Math.max(relevancePct, 10);

  return (
    <aside className="citation-panel" aria-label="Source citation">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="citation-panel__header">
        <span className="citation-panel__title">
          Source [{citation.citationNumber}]
        </span>
        <button
          className="citation-panel__close"
          onClick={onClose}
          aria-label="Close citation panel"
        >
          &#215;
        </button>
      </div>

      {/* ── Metadata ───────────────────────────────────────────────────────── */}
      <div className="citation-panel__meta">
        <span className="citation-panel__filename">{citation.filename}</span>
        <span className="citation-panel__position">
          Chunk {citation.chunkIndex + 1} of {citation.totalChunks}
        </span>
        <div className="citation-panel__relevance">
          <div className="citation-panel__score-bar-track">
            <span
              className="citation-panel__score-bar"
              style={{ width: `${barWidth}%` }}
            />
          </div>
          <span className="citation-panel__score">{relevancePct}% relevant</span>
        </div>
      </div>

      {/* ── Chunk text ─────────────────────────────────────────────────────── */}
      {/* This is the verbatim text that was retrieved from Qdrant and fed to
          the LLM as context. Displaying it verbatim is intentional — it lets
          the user verify the LLM did not fabricate or misrepresent the source. */}
      <blockquote className="citation-panel__text">
        {citation.text}
      </blockquote>
    </aside>
  );
}
