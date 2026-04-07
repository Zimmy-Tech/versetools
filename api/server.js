// VerseTools API Server
// Phase 1: Skeleton with health check + db proxy

import express from 'express';
import cors from 'cors';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// CORS — allow the frontend (DO static site + GitHub Pages + localhost dev)
app.use(cors({
  origin: [
    'http://localhost:4200',
    'https://verse-tools-app-95jai.ondigitalocean.app',
    'https://zimmy-tech.github.io',
    'https://versetools.com',
  ],
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));

// Note: DigitalOcean strips the /api route prefix before forwarding,
// so routes here are mounted without it. Externally these are still /api/*.

// Health check — required by DigitalOcean
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '0.1.0',
    phase: 'Phase 1 — skeleton',
  });
});

// Phase 1 Stage A: proxy mode — return static JSON
// Phase 1 Stage B: replace with database query
app.get('/db', (req, res) => {
  try {
    const jsonPath = join(__dirname, 'data', 'versedb_data.json');
    const data = readFileSync(jsonPath, 'utf-8');
    res.setHeader('Content-Type', 'application/json');
    res.send(data);
  } catch (err) {
    console.error('Failed to load db:', err);
    res.status(500).json({ error: 'Failed to load database' });
  }
});

// Catch-all for unimplemented routes
app.use('/*', (req, res) => {
  res.status(404).json({ error: 'Not implemented yet', path: req.path });
});

app.listen(PORT, () => {
  console.log(`VerseTools API listening on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health (external: /api/health)`);
  console.log(`DB:     http://localhost:${PORT}/db     (external: /api/db)`);
});
