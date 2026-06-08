/*
 * WHAT THIS FILE DOES
 * The root React component. Owns the two pieces of global state — the list of
 * ingested documents and the active citation — and composes the three main
 * panels: DocumentUploader, ChatInterface, and CitationPanel.
 *
 * WHERE IT FITS IN THE ARCHITECTURE
 * App.tsx is the "coordinator". Each panel is self-contained for its own
 * concerns (uploading, chatting, displaying a source) but they need to share
 * two values: the document list (uploader writes it, chat reads it as context
 * for the empty state) and the active citation (chat writes it, CitationPanel
 * reads it). App.tsx is the minimal shared owner of those two values.
 *
 * THE KEY CONCEPT TO UNDERSTAND
 * "Lifting state up" is the React pattern for sharing state between sibling
 * components. ChatInterface doesn't pass citations directly to CitationPanel —
 * they're siblings, so the citation travels up to App via a callback, and App
 * passes it back down to CitationPanel as a prop. This keeps both components
 * independently testable.
 *
 * INTERVIEW TALKING POINT
 * "App.tsx owns exactly two pieces of state: documents and activeCitation.
 * Everything else — message history, upload progress, input text — lives in
 * the component that owns it. I avoided global state management (Redux, Zustand)
 * because the state tree is shallow enough that prop drilling is cleaner."
 */

import { useState, useLayoutEffect } from 'react';
import { DocumentUploader } from './components/DocumentUploader';
import { ChatInterface } from './components/ChatInterface';
import { CitationPanel } from './components/CitationPanel';
import type { CitationSource, IngestedDocument } from './types';

export function App() {
  const [documents, setDocuments] = useState<IngestedDocument[]>([]);
  const [activeCitation, setActiveCitation] = useState<CitationSource | null>(null);

  // Lazy initializer reads localStorage once — no extra render on mount.
  const [darkMode, setDarkMode] = useState<boolean>(
    () => localStorage.getItem('docsense-dark-mode') === 'true'
  );

  // useLayoutEffect fires after React commits to the DOM but before the
  // browser paints, so the class is always set before the user sees anything.
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
    localStorage.setItem('docsense-dark-mode', String(darkMode));
  }, [darkMode]);

  function handleDocumentIngested(doc: IngestedDocument) {
    // Guard against duplicate entries if the same file is re-uploaded.
    setDocuments((prev) => {
      const exists = prev.some((d) => d.filename === doc.filename);
      return exists
        ? prev.map((d) => (d.filename === doc.filename ? doc : d))
        : [...prev, doc];
    });
  }

  return (
    <div className="app">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="app-header">
        <span className="app-header__logo">
          Doc<span>Sense</span>
        </span>
        <span className="app-header__tagline">
          Document intelligence, on-premises
        </span>
        <button
          className="theme-toggle"
          onClick={() => setDarkMode((prev) => !prev)}
          aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {darkMode ? '☀' : '☾'}
        </button>
      </header>

      {/* ── Three-panel body ───────────────────────────────────────────── */}
      <div className="app-body">
        <DocumentUploader
          documents={documents}
          onDocumentIngested={handleDocumentIngested}
        />

        <ChatInterface
          onCitationSelect={setActiveCitation}
          activeCitation={activeCitation}
        />

        {/* CitationPanel is conditionally rendered — the chat area expands
            to fill the space when no citation is selected. */}
        {activeCitation && (
          <CitationPanel
            citation={activeCitation}
            onClose={() => setActiveCitation(null)}
          />
        )}
      </div>
    </div>
  );
}
