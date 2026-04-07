// VerseTools API Server
// Phase 1: Skeleton with health check + db proxy

import express from 'express';
import cors from 'cors';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { dbEnabled, initSchema, importIfEmpty, exportFullDb } from './db.js';

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

// Routes are registered both with and without /api prefix so the server
// works regardless of whether DigitalOcean strips the route prefix.

const healthHandler = (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '0.1.1',
    phase: dbEnabled ? 'Phase 1 — db' : 'Phase 1 — proxy',
    db: dbEnabled,
  });
};

const dbHandler = async (req, res) => {
  try {
    if (dbEnabled) {
      const data = await exportFullDb();
      res.setHeader('Content-Type', 'application/json');
      res.json(data);
    } else {
      // Fallback: serve the static JSON file
      const jsonPath = join(__dirname, 'data', 'versedb_data.json');
      const data = readFileSync(jsonPath, 'utf-8');
      res.setHeader('Content-Type', 'application/json');
      res.send(data);
    }
  } catch (err) {
    console.error('Failed to load db:', err);
    res.status(500).json({ error: 'Failed to load database', detail: err.message });
  }
};

app.get('/health', healthHandler);
app.get('/api/health', healthHandler);
app.get('/db', dbHandler);
app.get('/api/db', dbHandler);

// Root — useful for sanity checking
app.get('/', (req, res) => {
  res.json({ service: 'versetools-api', see: ['/health', '/db', '/api/health', '/api/db'] });
});

async function start() {
  if (dbEnabled) {
    try {
      await initSchema();
      await importIfEmpty();
    } catch (err) {
      console.error('[db] init failed:', err);
      // Don't crash — fall back to file proxy so the site stays up
    }
  } else {
    console.log('[db] DATABASE_URL not set — running in file-proxy mode');
  }

  app.listen(PORT, () => {
    console.log(`VerseTools API listening on port ${PORT}`);
    console.log(`Health: http://localhost:${PORT}/health (external: /api/health)`);
    console.log(`DB:     http://localhost:${PORT}/db     (external: /api/db)`);
  });
}

start();
