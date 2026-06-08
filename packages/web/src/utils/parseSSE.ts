/*
 * WHAT THIS FILE DOES
 * Reads a streaming fetch() response and yields the JSON payload from each
 * Server-Sent Event. Shared by the upload and query components — both consume
 * SSE streams over POST requests, which the native EventSource API can't do.
 *
 * WHERE IT FITS IN THE ARCHITECTURE
 * This sits between the raw HTTP response and the component event handlers.
 * DocumentUploader and ChatInterface both call parseSSE() and then switch on
 * the `type` field of each parsed event to update their local state.
 *
 * THE KEY CONCEPT TO UNDERSTAND
 * A fetch() response body is a ReadableStream<Uint8Array> — a stream of raw
 * bytes. SSE events are text delimited by double newlines ("\n\n"). Because
 * a single ReadableStream chunk may contain multiple events OR only part of
 * one event, we buffer the decoded text and split on "\n\n" to extract
 * complete events. This is the same pattern as reading newline-delimited JSON
 * from a TCP socket: buffer until you have a full record, then process it.
 *
 * INTERVIEW TALKING POINT
 * "I use fetch() + ReadableStream rather than EventSource because EventSource
 * only supports GET — our SSE endpoints are POST since they need a body. The
 * manual buffering adds ~15 lines but is straightforward once you understand
 * the SSE delimiter contract."
 */

export async function* parseSSE(response: Response): AsyncGenerator<string> {
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by "\n\n". Split on that delimiter and process
    // all complete events. The trailing slice (which may be an incomplete
    // event) stays in the buffer until the next chunk arrives.
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';

    for (const part of parts) {
      const line = part.trim();
      if (line.startsWith('data: ')) {
        yield line.slice(6); // strip the "data: " prefix, yield the raw JSON
      }
    }
  }
}
