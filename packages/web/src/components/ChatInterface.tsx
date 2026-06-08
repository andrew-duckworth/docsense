/*
 * WHAT THIS FILE DOES
 * Renders the chat area: a scrollable message history, a streaming text
 * display for the AI's answer, inline citation badges that open the source
 * panel, and a textarea input for asking questions.
 *
 * WHERE IT FITS IN THE ARCHITECTURE
 * This is the HTTP boundary for the query pipeline on the frontend side.
 * It calls POST /query with the user's question, then consumes the SSE stream:
 *   `chunk` events  → appended to the live assistant message as tokens arrive
 *   `citations`     → activates the [N] badges on the completed message
 *   `error`/`done`  → ends the streaming state
 *
 * THE KEY CONCEPT TO UNDERSTAND
 * Citation badges only become clickable after the `citations` SSE event
 * arrives, which happens after the full answer text is streamed. While
 * streaming, [1] and [2] appear as plain text. Once citations land they
 * re-render as interactive buttons. This staging is intentional — it signals
 * to the user that the answer is complete and sources are ready to inspect.
 *
 * INTERVIEW TALKING POINT
 * "Streaming the answer token-by-token is a UX decision as much as a
 * technical one — it gives the user something to read immediately rather than
 * waiting 8+ seconds for a complete response, and the arriving text makes the
 * system feel responsive even when the LLM is slow."
 */

import { useEffect, useRef, useState } from 'react';
import type { CitationSource, Message } from '../types';
import { parseSSE } from '../utils/parseSSE';

interface Props {
  onCitationSelect: (citation: CitationSource | null) => void;
  activeCitation: CitationSource | null;
}

export function ChatInterface({ onCitationSelect, activeCitation }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Scroll to the latest message whenever messages update.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function sendQuestion() {
    const question = input.trim();
    if (!question || isStreaming) return;

    setInput('');
    resetTextareaHeight();
    setIsStreaming(true);

    const userMsg: Message = { id: `u-${Date.now()}`, role: 'user', text: question };
    const assistantId = `a-${Date.now() + 1}`;
    const assistantMsg: Message = { id: assistantId, role: 'assistant', text: '', isStreaming: true };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    // Close any open citation panel when a new question is asked.
    onCitationSelect(null);

    try {
      const response = await fetch('/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      });

      if (!response.ok || !response.body) {
        const text = await response.text();
        let message = `Request failed (${response.status})`;
        try { message = (JSON.parse(text) as { error?: string }).error ?? message; } catch { /* leave default */ }
        setMessages((prev) =>
          prev.map((m) => m.id === assistantId ? { ...m, text: message, isStreaming: false } : m)
        );
        return;
      }

      for await (const raw of parseSSE(response)) {
        const event = JSON.parse(raw) as
          | { type: 'chunk'; text: string }
          | { type: 'citations'; sources: CitationSource[] }
          | { type: 'error'; message: string }
          | { type: 'done' };

        if (event.type === 'chunk') {
          setMessages((prev) =>
            prev.map((m) => m.id === assistantId ? { ...m, text: m.text + event.text } : m)
          );
        } else if (event.type === 'citations') {
          setMessages((prev) =>
            prev.map((m) => m.id === assistantId ? { ...m, citations: event.sources } : m)
          );
        } else if (event.type === 'error') {
          setMessages((prev) =>
            prev.map((m) => m.id === assistantId ? { ...m, text: event.message, isStreaming: false } : m)
          );
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Network error';
      setMessages((prev) =>
        prev.map((m) => m.id === assistantId ? { ...m, text: errMsg, isStreaming: false } : m)
      );
    } finally {
      setMessages((prev) =>
        prev.map((m) => m.id === assistantId ? { ...m, isStreaming: false } : m)
      );
      setIsStreaming(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendQuestion();
    }
  }

  function handleInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value);
    // Auto-grow the textarea up to its CSS max-height.
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }

  function resetTextareaHeight() {
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }

  function handleCitationBadgeClick(citation: CitationSource) {
    // Toggle: clicking the same badge again closes the panel.
    const isSame =
      activeCitation?.citationNumber === citation.citationNumber &&
      activeCitation?.filename === citation.filename;
    onCitationSelect(isSame ? null : citation);
  }

  return (
    <div className="chat">
      {/* ── Message list ─────────────────────────────────────────────────── */}
      <div className="chat__messages">
        {messages.length === 0 && (
          <div className="chat__empty">
            <span className="chat__empty-icon">&#9632;</span>
            <span className="chat__empty-title">DocSense</span>
            <span className="chat__empty-subtitle">
              Upload a document, then ask a question about it.
            </span>
            <span className="chat__empty-subtitle">
              Shift+Enter for a new line &middot; Enter to send
            </span>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={[
              'message',
              `message--${msg.role}`,
              msg.isStreaming ? 'message--streaming' : '',
            ].join(' ')}
          >
            <div className="message__bubble">
              {msg.role === 'assistant'
                ? renderTextWithBadges(msg.text, msg.citations, activeCitation, handleCitationBadgeClick)
                : msg.text}
            </div>

            {/* Citation source list — appears below the bubble once citations arrive */}
            {msg.role === 'assistant' && msg.citations && msg.citations.length > 0 && !msg.isStreaming && (
              <div className="message__citations">
                <span className="message__citation-hint">Sources:</span>
                {msg.citations.map((c) => (
                  <button
                    key={c.citationNumber}
                    className={[
                      'citation-source-btn',
                      activeCitation?.citationNumber === c.citationNumber && activeCitation?.filename === c.filename
                        ? 'citation-source-btn--active'
                        : '',
                    ].join(' ')}
                    onClick={() => handleCitationBadgeClick(c)}
                    title={`${c.filename} — chunk ${c.chunkIndex + 1} of ${c.totalChunks}`}
                  >
                    [{c.citationNumber}] {truncate(c.filename, 24)}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}

        <div ref={messagesEndRef} />
      </div>

      {/* ── Input bar ────────────────────────────────────────────────────── */}
      <div className="chat__input-area">
        <textarea
          ref={textareaRef}
          className="chat__textarea"
          placeholder={isStreaming ? 'Waiting for response…' : 'Ask a question about your documents…'}
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          disabled={isStreaming}
          rows={1}
        />
        <button
          className="chat__send-btn"
          onClick={() => void sendQuestion()}
          disabled={isStreaming || !input.trim()}
          aria-label="Send question"
        >
          &#8594;
        </button>
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Splits message text on [N] markers and renders them as clickable badges
 * when the citations array is populated. Before citations arrive (during
 * streaming), [N] markers render as plain text.
 */
function renderTextWithBadges(
  text: string,
  citations: CitationSource[] | undefined,
  activeCitation: CitationSource | null,
  onBadgeClick: (c: CitationSource) => void,
): React.ReactNode {
  if (!citations?.length) return text;

  // The capturing group keeps the markers in the output array.
  const parts = text.split(/(\[\d+\])/g);

  return (
    <>
      {parts.map((part, i) => {
        const match = part.match(/^\[(\d+)\]$/);
        if (!match) return <span key={i}>{part}</span>;

        const num = parseInt(match[1], 10);
        const citation = citations.find((c) => c.citationNumber === num);
        if (!citation) return <span key={i}>{part}</span>;

        const isActive =
          activeCitation?.citationNumber === num &&
          activeCitation?.filename === citation.filename;

        return (
          <button
            key={i}
            className={`citation-badge${isActive ? ' citation-badge--active' : ''}`}
            onClick={() => onBadgeClick(citation)}
            title={`${citation.filename} — chunk ${citation.chunkIndex + 1} of ${citation.totalChunks}`}
          >
            {part}
          </button>
        );
      })}
    </>
  );
}

function truncate(str: string, maxLen: number): string {
  return str.length <= maxLen ? str : `…${str.slice(-(maxLen - 1))}`
}
