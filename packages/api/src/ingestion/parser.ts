/*
 * WHAT THIS FILE DOES
 * Receives a file buffer and filename, detects whether it is a PDF or DOCX,
 * and returns the document's plain text content ready for chunking.
 *
 * WHERE IT FITS IN THE ARCHITECTURE
 * This is step 1 of the ingestion pipeline — it runs immediately after the
 * upload route receives the file, before chunking or embedding happen.
 * Upload route → parser.ts → chunker.ts → embedder.ts → vectorStore.ts
 *
 * THE KEY CONCEPT TO UNDERSTAND
 * PDF and DOCX are binary formats — the bytes on disk are not readable text.
 * pdf-parse and mammoth are "decoders" that know those binary specs and hand
 * you back a plain string. Think of them like JSON.parse() but for documents.
 *
 * INTERVIEW TALKING POINT
 * "Parsing is isolated in its own module so we can add new file types — HTML,
 * CSV, plain text — without touching any downstream pipeline logic."
 */

import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import path from 'path';

export interface ParseResult {
  text: string;
  filename: string;
  fileType: 'pdf' | 'docx';
  characterCount: number;
}

// DECISION: We detect file type from the extension, not the MIME type sent by
// the client. MIME types can be spoofed or wrong (e.g. browsers sometimes send
// application/octet-stream for both). Extension is a reliable enough signal
// here because we control the upload validation in the route layer.
function detectFileType(filename: string): 'pdf' | 'docx' {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  throw new Error(`Unsupported file type: "${ext}". Only .pdf and .docx are supported.`);
}

async function parsePdf(buffer: Buffer): Promise<string> {
  const data = await pdfParse(buffer);
  // pdf-parse gives us a .text property with all pages concatenated.
  // It includes form-feed characters (\f) between pages — we normalise those
  // to newlines so downstream code sees a consistent string.
  return data.text.replace(/\f/g, '\n').trim();
}

async function parseDocx(buffer: Buffer): Promise<string> {
  // mammoth.extractRawText strips all Word formatting and gives back plain text.
  // The alternative, mammoth.convertToHtml, preserves headings/bold/etc but
  // that markup would pollute our embeddings — raw text is what we want.
  const result = await mammoth.extractRawText({ buffer });
  return result.value.trim();
}

export async function parseFile(buffer: Buffer, filename: string): Promise<ParseResult> {
  const fileType = detectFileType(filename);

  const text = fileType === 'pdf'
    ? await parsePdf(buffer)
    : await parseDocx(buffer);

  if (!text || text.length === 0) {
    throw new Error(`Parsing produced no text from "${filename}". The file may be scanned/image-only.`);
  }

  return {
    text,
    filename,
    fileType,
    characterCount: text.length,
  };
}
