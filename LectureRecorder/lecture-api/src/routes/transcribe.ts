import { Router } from 'express';
import multer from 'multer';
import { openAsBlob } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { config } from '../config';

const router = Router();
const upload = multer({ dest: tmpdir(), limits: { files: 1, fileSize: 25_000_000, fields: 1 } });

router.post(['/', '/quick'], upload.single('audio'), async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: '녹음 파일을 첨부해 주세요.' });
    return;
  }
  try {
    const form = new FormData();
    form.set('file', await openAsBlob(file.path, { type: file.mimetype }), file.originalname);
    form.set('model', 'whisper-large-v3-turbo');
    const language = req.query.language ?? req.body.language;
    if (['en', 'ko', 'zh'].includes(language)) form.set('language', language);

    const upstream = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.groqKey}` },
      body: form,
      signal: AbortSignal.timeout(90000),
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      if (upstream.status === 429) {
        res.set('Retry-After', upstream.headers.get('retry-after') || '60');
        res.status(429).json({ error: '전사 사용 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.' });
      } else {
        res.status(upstream.status === 413 ? 413 : 502).json({ error: '녹음 파일을 전사하지 못했습니다.' });
      }
      return;
    }
    const data = await upstream.json() as { text?: string };
    if (typeof data.text !== 'string') throw new Error('Unexpected response');
    res.json({ text: data.text });
  } catch {
    res.status(502).json({ error: '음성 인식 서비스에 연결하지 못했습니다.' });
  } finally {
    await unlink(file.path).catch(() => console.warn('[transcribe] 임시 파일 정리 실패'));
  }
});

export default router;
