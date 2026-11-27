import { Router, Request, Response } from 'express';
import axios from 'axios';
import { config } from '../config';

/**
 * Study features built on top of a lecture transcript:
 *   POST /api/quiz      { text, language?, count? }      → { quiz: QuizQuestion[] }
 *   POST /api/chat      { text, messages, language? }    → { reply: string }
 *   POST /api/chapters  { segments, language? }          → { chapters: { title, startMs }[] }
 */
const router = Router();

type Lang = 'ko' | 'en' | 'zh';
const LANG_NAME: Record<Lang, string> = { ko: 'Korean', en: 'English', zh: 'Chinese' };
const langOf = (v: unknown): Lang => (v === 'en' || v === 'zh' ? v : 'ko');

// gpt-4o-mini handles ~128k tokens, but long inputs cost more and degrade quality.
// Long lectures (80k–150k chars) are sampled evenly so every part of the lecture is represented.
const MAX_CONTEXT_CHARS = 60_000;

function fitText(text: string, max = MAX_CONTEXT_CHARS): string {
  if (text.length <= max) return text;
  const parts = 6;
  const sliceLen = Math.floor(max / parts);
  const step = Math.floor((text.length - sliceLen) / (parts - 1));
  const slices: string[] = [];
  for (let i = 0; i < parts; i++) slices.push(text.slice(i * step, i * step + sliceLen));
  return slices.join('\n…\n');
}

async function callOpenAI(
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
  opts: { json?: boolean; maxTokens: number; temperature?: number; timeout?: number }
): Promise<string> {
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens,
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    },
    {
      headers: { Authorization: `Bearer ${config.openAiKey}`, 'Content-Type': 'application/json' },
      timeout: opts.timeout ?? 90_000,
    }
  );
  return response.data.choices[0].message.content ?? '';
}

function requireText(req: Request, res: Response): string | null {
  const text = (req.body as { text?: unknown }).text;
  if (typeof text !== 'string' || text.trim().length === 0) {
    res.status(400).json({ error: 'Request body must include a non-empty "text" field.' });
    return null;
  }
  return text;
}

// ── Quiz ──────────────────────────────────────────────────────────────────────

router.post('/quiz', async (req: Request, res: Response) => {
  const text = requireText(req, res);
  if (text === null) return;
  const language = langOf(req.body.language);
  const count = Math.min(10, Math.max(3, Number(req.body.count) || 5));

  const system = `You write exam-style multiple-choice questions for a university student reviewing a lecture.
Write everything in ${LANG_NAME[language]}.
Rules:
- Exactly ${count} questions, each testing a different important concept actually taught in the lecture.
- Each has exactly 4 options; exactly one is correct. Distractors must be plausible, not silly.
- Do not ask about the speaker, jokes, or administrative remarks.
- "explanation" says in 1–2 sentences why the answer is correct, grounded in the lecture.
Output ONLY this JSON:
{"quiz":[{"question":"...","options":["...","...","...","..."],"answerIndex":0,"explanation":"..."}]}`;

  try {
    const raw = await callOpenAI(
      [
        { role: 'system', content: system },
        { role: 'user', content: `Lecture transcript:\n\n${fitText(text)}` },
      ],
      { json: true, maxTokens: 3000, temperature: 0.5 }
    );
    const parsed = JSON.parse(raw) as { quiz?: unknown };
    const quiz = (Array.isArray(parsed.quiz) ? parsed.quiz : [])
      .filter(
        (q: any) =>
          q &&
          typeof q.question === 'string' &&
          Array.isArray(q.options) &&
          q.options.length >= 2 &&
          Number.isInteger(q.answerIndex) &&
          q.answerIndex >= 0 &&
          q.answerIndex < q.options.length
      )
      .map((q: any) => ({
        question: q.question,
        options: q.options.map(String),
        answerIndex: q.answerIndex,
        explanation: typeof q.explanation === 'string' ? q.explanation : '',
      }));
    if (quiz.length === 0) {
      res.status(502).json({ error: '퀴즈를 생성하지 못했습니다.' });
      return;
    }
    res.json({ quiz });
  } catch (err: any) {
    console.error('[quiz] Error:', err.response?.data ?? err.message);
    res.status(500).json({ error: '퀴즈 생성에 실패했습니다.' });
  }
});

// ── Chat ──────────────────────────────────────────────────────────────────────

router.post('/chat', async (req: Request, res: Response) => {
  const text = requireText(req, res);
  if (text === null) return;
  const language = langOf(req.body.language);
  const rawMessages: unknown = req.body.messages;

  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    res.status(400).json({ error: 'Request body must include a non-empty "messages" array.' });
    return;
  }
  // Keep the last 12 turns; drop anything malformed.
  const messages = rawMessages
    .filter(
      (m: any) =>
        m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim()
    )
    .slice(-12)
    .map((m: any) => ({ role: m.role as 'user' | 'assistant', content: String(m.content).slice(0, 4000) }));

  if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
    res.status(400).json({ error: 'The last message must be from the user.' });
    return;
  }

  const system = `You are a study assistant helping a student understand a lecture they recorded.
Answer in ${LANG_NAME[language]} unless the student writes in another language.
- Base your answer on the lecture transcript below first. When you quote or rely on it, say so plainly (e.g. "강의에서는 …").
- If the lecture does not cover the question, say that clearly, then you may add general knowledge, marked as such (e.g. "강의 밖 내용이지만 …").
- Be concise: short paragraphs or bullet points. No markdown headings.
- The transcript is speech-to-text and may contain recognition errors; interpret sensibly.

Lecture transcript:
"""
${fitText(text)}
"""`;

  try {
    const reply = await callOpenAI([{ role: 'system', content: system }, ...messages], {
      maxTokens: 1200,
      temperature: 0.4,
    });
    if (!reply.trim()) {
      res.status(502).json({ error: '답변을 생성하지 못했습니다.' });
      return;
    }
    res.json({ reply: reply.trim() });
  } catch (err: any) {
    console.error('[chat] Error:', err.response?.data ?? err.message);
    res.status(500).json({ error: '답변 생성에 실패했습니다.' });
  }
});

// ── Chapters ─────────────────────────────────────────────────────────────────

router.post('/chapters', async (req: Request, res: Response) => {
  const language = langOf(req.body.language);
  const rawSegments: unknown = req.body.segments;

  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    res.status(400).json({ error: 'Request body must include a non-empty "segments" array.' });
    return;
  }
  const segments = rawSegments
    .filter((s: any) => s && typeof s.text === 'string' && typeof s.startMs === 'number' && s.text.trim())
    .map((s: any) => ({ startMs: Math.max(0, Math.round(s.startMs)), text: s.text.trim() }))
    .sort((a, b) => a.startMs - b.startMs);

  if (segments.length === 0) {
    res.status(400).json({ error: 'No usable segments.' });
    return;
  }

  // Trim each segment so even a 2-hour lecture fits comfortably.
  const perSegment = Math.max(200, Math.floor(MAX_CONTEXT_CHARS / segments.length));
  const listing = segments.map((s, i) => `[${i}] ${s.text.slice(0, perSegment)}`).join('\n');
  const target = Math.min(12, Math.max(1, Math.round(segments.length / 6)));

  const system = `You split a lecture into topic chapters. The transcript is given as numbered segments in time order.
Write chapter titles in ${LANG_NAME[language]}, each at most 25 characters, naming the topic (not "Part 1").
- About ${target} chapters (fewer if the lecture is short or stays on one topic).
- Each chapter starts at a segment index where a new topic begins. The first chapter starts at 0.
Output ONLY this JSON:
{"chapters":[{"title":"...","startIndex":0}]}`;

  try {
    const raw = await callOpenAI(
      [
        { role: 'system', content: system },
        { role: 'user', content: listing },
      ],
      { json: true, maxTokens: 1000, temperature: 0.2 }
    );
    const parsed = JSON.parse(raw) as { chapters?: unknown };
    const seen = new Set<number>();
    const chapters = (Array.isArray(parsed.chapters) ? parsed.chapters : [])
      .filter((c: any) => c && typeof c.title === 'string' && Number.isInteger(c.startIndex))
      .map((c: any) => ({
        title: c.title.trim(),
        index: Math.min(segments.length - 1, Math.max(0, c.startIndex)),
      }))
      .filter((c) => (seen.has(c.index) ? false : (seen.add(c.index), true)))
      .sort((a, b) => a.index - b.index)
      .map((c) => ({ title: c.title, startMs: segments[c.index].startMs }));

    if (chapters.length === 0) {
      res.status(502).json({ error: '챕터를 생성하지 못했습니다.' });
      return;
    }
    res.json({ chapters });
  } catch (err: any) {
    console.error('[chapters] Error:', err.response?.data ?? err.message);
    res.status(500).json({ error: '챕터 생성에 실패했습니다.' });
  }
});

export default router;
