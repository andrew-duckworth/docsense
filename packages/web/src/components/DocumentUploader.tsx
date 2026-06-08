/*
 * WHAT THIS FILE DOES
 * Renders the left sidebar: a drag-and-drop file upload zone with a live
 * progress pipeline display, and a list of successfully ingested documents.
 *
 * WHERE IT FITS IN THE ARCHITECTURE
 * This is the entry point for the ingestion pipeline in the UI. It calls
 * POST /upload with a multipart form body, then reads the SSE response to
 * display each pipeline stage (parsing → chunking → embedding → storing)
 * as it completes. When the `done` event arrives it notifies App.tsx so the
 * document appears in the global list.
 *
 * THE KEY CONCEPT TO UNDERSTAND
 * The upload is a POST, so we can't use the browser's native EventSource API
 * (it only supports GET). Instead, we use fetch() and read the response body
 * as a ReadableStream via parseSSE(). This lets us stream progress events
 * without needing a WebSocket or polling.
 *
 * INTERVIEW TALKING POINT
 * "The uploader shows each pipeline stage completing in real time because the
 * backend is designed to send SSE progress events, not buffer the whole
 * response. Embedding 50+ chunks takes several seconds — without streaming
 * the UI would appear frozen."
 */

import { useRef, useState } from 'react';
import type { IngestedDocument, UploadStatus, UploadStage } from '../types';
import { parseSSE } from '../utils/parseSSE';

interface Props {
  documents: IngestedDocument[];
  onDocumentIngested: (doc: IngestedDocument) => void;
}

const STAGE_ORDER: UploadStage[] = ['parsing', 'chunking', 'embedding', 'storing'];

const STAGE_LABELS: Record<UploadStage, string> = {
  parsing:   'Parsing document',
  chunking:  'Splitting into chunks',
  embedding: 'Generating embeddings',
  storing:   'Storing in Qdrant',
};

export function DocumentUploader({ documents, onDocumentIngested }: Props) {
  const [status, setStatus] = useState<UploadStatus>({ phase: 'idle' });
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function uploadFile(file: File) {
    setStatus({ phase: 'uploading', stage: 'parsing', message: `Parsing "${file.name}"…` });

    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch('/upload', { method: 'POST', body: formData });

      // Multer validation errors (e.g. file too large) return JSON before SSE headers.
      if (!response.ok || !response.body) {
        const text = await response.text();
        let message = `Upload failed (${response.status})`;
        try { message = (JSON.parse(text) as { error?: string }).error ?? message; } catch { /* leave default */ }
        setStatus({ phase: 'error', message });
        return;
      }

      for await (const raw of parseSSE(response)) {
        const event = JSON.parse(raw) as
          | { type: 'progress'; stage: UploadStage; message: string }
          | { type: 'done'; result: IngestedDocument }
          | { type: 'error'; message: string };

        if (event.type === 'progress') {
          setStatus({ phase: 'uploading', stage: event.stage, message: event.message });
        } else if (event.type === 'done') {
          setStatus({ phase: 'done', document: event.result });
          onDocumentIngested(event.result);
          // Reset to idle after a short delay so the user sees the success state.
          setTimeout(() => setStatus({ phase: 'idle' }), 3000);
        } else if (event.type === 'error') {
          setStatus({ phase: 'error', message: event.message });
        }
      }
    } catch (err) {
      setStatus({ phase: 'error', message: err instanceof Error ? err.message : 'Network error' });
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void uploadFile(file);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void uploadFile(file);
    // Reset input so the same file can be re-uploaded if needed.
    e.target.value = '';
  }

  const isUploading = status.phase === 'uploading';

  return (
    <div className="uploader">
      <h2 className="sidebar-title">Documents</h2>

      {/* Drop zone — clicking opens the hidden file input */}
      <div
        className={[
          'drop-zone',
          isDragOver ? 'drop-zone--over' : '',
          isUploading ? 'drop-zone--busy' : '',
        ].join(' ')}
        role="button"
        tabIndex={0}
        aria-label="Upload a PDF or DOCX file"
        onClick={() => !isUploading && inputRef.current?.click()}
        onKeyDown={(e) => e.key === 'Enter' && !isUploading && inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.docx"
          className="drop-zone__input"
          onChange={handleFileChange}
        />
        {isUploading ? (
          <span className="drop-zone__label">Ingesting…</span>
        ) : status.phase === 'done' ? (
          <>
            <span className="drop-zone__icon drop-zone__icon--success">&#10003;</span>
            <span className="drop-zone__label">Ingested</span>
            <span className="drop-zone__hint">drop another file to add it</span>
          </>
        ) : (
          <>
            <span className="drop-zone__icon">&#8679;</span>
            <span className="drop-zone__label">Drop PDF or DOCX</span>
            <span className="drop-zone__hint">or click to browse</span>
          </>
        )}
      </div>

      {/* Pipeline stage progress — shown while uploading */}
      {isUploading && (
        <div className="upload-progress">
          {STAGE_ORDER.map((stage) => {
            const currentIdx = STAGE_ORDER.indexOf(status.stage);
            const stageIdx   = STAGE_ORDER.indexOf(stage);
            const isDone     = stageIdx < currentIdx;
            const isActive   = stage === status.stage;
            return (
              <div
                key={stage}
                className={[
                  'upload-stage',
                  isDone   ? 'upload-stage--done'   : '',
                  isActive ? 'upload-stage--active' : '',
                ].join(' ')}
              >
                <span className="upload-stage__dot" />
                {STAGE_LABELS[stage]}
              </div>
            );
          })}
        </div>
      )}

      {/* Error state */}
      {status.phase === 'error' && (
        <div className="upload-error">
          <strong>Error:</strong> {status.message}
          <button className="link-btn" onClick={() => setStatus({ phase: 'idle' })}>Dismiss</button>
        </div>
      )}

      {/* Ingested document list */}
      {documents.length > 0 && (
        <ul className="document-list">
          {documents.map((doc) => (
            <li key={`${doc.filename}-${doc.chunksCreated}`} className="document-item">
              <span className="document-item__icon">&#10003;</span>
              <div className="document-item__body">
                <span className="document-item__name" title={doc.filename}>
                  {doc.filename}
                </span>
                <span className="document-item__meta">
                  {doc.chunksCreated} chunks &middot; {doc.characterCount.toLocaleString()} chars
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
