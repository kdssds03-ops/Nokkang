import express from 'express';
import { config } from './config';
import transcribeRouter from './routes/transcribe';
import summarizeRouter from './routes/summarize';

const app = express();
const PORT = process.env.PORT || 3000;

// ── Startup env validation ────────────────────────────────────────────────────
// Log clearly which keys are present/missing so Railway logs immediately reveal
// the cause of any 401 / 500 / 502 errors on first deploy.
function validateEnv(): void {
  console.log('[startup] Validating required environment variables...');
  const checks = [
    { key: 'GROQ_API_KEY', value: config.groqKey, desc: 'transcription (Groq)' },
    { key: 'OPENAI_API_KEY',     value: config.openAiKey,     desc: 'summarization' },
    { key: 'APP_SECRET',         value: config.appSecret, desc: 'request authentication' },
  ];
  let allOk = true;
  for (const { key, value, desc } of checks) {
    if (value) {
      console.log(`[startup]   ✓ ${key} — configured (${desc})`);
    } else {
      console.warn(`[startup]   ✗ ${key} — MISSING — ${desc} will fail!`);
      allOk = false;
    }
  }
  if (allOk) {
    console.log('[startup] All required env vars are configured.');
  } else {
    console.warn('[startup] WARNING: One or more required env vars are missing. See above.');
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── CORS (allow all origins for mobile app) ───────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-app-key, x-device-id, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

// ── Auth middleware ───────────────────────────────────────────────────────────
// Validates x-app-key header against APP_SECRET env var
app.use((req, res, next) => {
  // Skip auth for health check
  if (req.path === '/health' || req.path === '/') {
    return next();
  }

  const appKey = req.headers['x-app-key'];
  if (!appKey || appKey !== config.appSecret) {
    res.status(401).json({ error: '인증에 실패했습니다. 올바른 앱 키를 설정해 주세요.' });
    return;
  }
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  const ready = Boolean(config.openAiKey && config.groqKey && config.appSecret);
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ok' : 'not_ready',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    services: {
      openai:     config.openAiKey     ? 'configured' : 'MISSING',
      groq: config.groqKey ? 'configured' : 'MISSING',
      appSecret:  config.appSecret ? 'configured' : 'MISSING',
    },
  });
});

app.get('/', (_req, res) => {
  res.json({ message: 'LectureRecorder API is running.' });
});

app.use('/api/transcribe', transcribeRouter);
app.use('/api/summarize', summarizeRouter);
// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Error handler ─────────────────────────────────────────────────────────────
// Belt-and-suspenders: catch multer errors that escape the per-route wrapper,
// plus any other unhandled errors from async route handlers.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Multer-specific errors (e.g. from a route that forgot to use uploadSingle wrapper)
  const multer = require('multer');
  if (err instanceof multer.MulterError) {
    console.warn(`[server] MulterError: code=${err.code} message=${err.message}`);
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    res.status(status).json({
      error: err.code === 'LIMIT_FILE_SIZE'
        ? '파일이 너무 큽니다.'
        : `업로드 오류: ${err.message}`,
      code: err.code,
    });
    return;
  }

  console.error('[server] Unhandled error:', err?.message ?? err);
  if (err?.stack) console.error('[server] Stack:', err.stack);
  res.status(500).json({ error: '서버 오류가 발생했습니다.' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
validateEnv();
const server = app.listen(PORT, () => {
  console.log(`[server] LectureRecorder API listening on port ${PORT}`);
});

// Increase server timeout for large file uploads (10 minutes)
server.timeout = 600_000;
server.keepAliveTimeout = 600_000;
server.headersTimeout = 601_000;

export default app;
