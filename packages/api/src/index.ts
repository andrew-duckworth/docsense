/*
 * WHAT THIS FILE DOES
 * The Express application entry point. Creates the HTTP server, wires up
 * middleware and routes, and starts listening for requests.
 *
 * WHERE IT FITS IN THE ARCHITECTURE
 * This is the outermost shell of the API. Nothing in src/ runs until this
 * file is executed. Think of it as the "main()" of the backend.
 *
 * THE KEY CONCEPT TO UNDERSTAND
 * Express middleware runs in order. Every request passes through the middleware
 * stack top to bottom before hitting a route handler. The JSON body parser must
 * come before the routes, otherwise req.body is undefined.
 *
 * INTERVIEW TALKING POINT
 * "The Express app is intentionally thin — it handles HTTP concerns like body
 * parsing and CORS, then delegates everything else to route modules that own
 * their own business logic."
 */

import 'dotenv/config';
import express from 'express';
import queryRouter from './routes/query';
import uploadRouter from './routes/upload';

const app = express();
const PORT = process.env.PORT ?? 3001;

// Parse JSON request bodies before any route handler sees the request.
app.use(express.json());

// Health check — useful for confirming the server is up before running tests.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/upload', uploadRouter);
app.use('/query', queryRouter);

app.listen(PORT, () => {
  console.log(`\nDocSense API running on http://localhost:${PORT}`);
  console.log(`  POST http://localhost:${PORT}/upload  ← ingest a PDF or DOCX`);
  console.log(`  POST http://localhost:${PORT}/query   ← ask a question`);
  console.log(`  GET  http://localhost:${PORT}/health\n`);
});
