/**
 * aiService.ts
 *
 * All AI calls go through OUR backend only.
 * No third-party API keys are stored here or on the device.
 *
 * Config stored in AsyncStorage:
 *   backend_url  — e.g. http://localhost:3000  or  https://your-app.up.railway.app
 *   app_secret   — matches APP_SECRET env var on the backend
 */
import { LectureType } from '@/store/useRecordingStore';
import type { RecognitionLanguage } from '@/store/useSettingsStore';
import AsyncStorage from '@react-native-async-storage/async-storage';
import axios, { AxiosResponse } from 'axios';
import * as FileSystem from 'expo-file-system/legacy';

// ── Config helpers ────────────────────────────────────────────────────────────

const BACKEND_URL_KEY = 'backend_url';
const APP_SECRET_KEY = 'app_secret';
const DEVICE_ID_KEY = 'device_id';

let cachedDeviceId: string | null = null;

function genDeviceId(): string {
  return 'dev-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

/** Stable per-install identifier used for server-side usage metering. */
export async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;
  let id = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = genDeviceId();
    await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  }
  cachedDeviceId = id;
  return id;
}
const DEVELOPER_MODE_KEY = 'developer_mode';

// EXPO_PUBLIC_BACKEND_URL is safe to embed (not a secret — it's just a URL).
// APP_SECRET is intentionally NOT sourced from an EXPO_PUBLIC_* var.

function normalizeBaseUrl(url: string): string {
  if (!url) return '';
  return url.trim().replace(/\/+$/, '');
}

const DEFAULT_BACKEND_URL = normalizeBaseUrl(process.env.EXPO_PUBLIC_BACKEND_URL || '');
const RECOGNITION_LANGUAGE_VALUES: RecognitionLanguage[] = ['auto', 'ko', 'en', 'zh'];

function normalizeRecognitionLanguage(
  recognitionLanguage: RecognitionLanguage | string | undefined
): RecognitionLanguage {
  if (!recognitionLanguage) return 'auto';
  return RECOGNITION_LANGUAGE_VALUES.includes(recognitionLanguage as RecognitionLanguage)
    ? (recognitionLanguage as RecognitionLanguage)
    : 'auto';
}

function buildLanguageQueryParam(recognitionLanguage: RecognitionLanguage): string {
  return recognitionLanguage === 'auto'
    ? ''
    : `?language=${encodeURIComponent(recognitionLanguage)}`;
}

export async function getRawBackendOverride(): Promise<string> {
  const url = await AsyncStorage.getItem(BACKEND_URL_KEY);
  return url?.trim() || '';
}

export async function clearBackendOverride(): Promise<void> {
  await AsyncStorage.removeItem(BACKEND_URL_KEY);
}

export async function getDeveloperMode(): Promise<boolean> {
  const val = await AsyncStorage.getItem(DEVELOPER_MODE_KEY);
  return val === 'true';
}

export async function setDeveloperMode(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(DEVELOPER_MODE_KEY, enabled ? 'true' : 'false');
}

export async function getBackendUrl(): Promise<string> {
  console.log(`[Diagnostic] raw env EXPO_PUBLIC_BACKEND_URL: ${process.env.EXPO_PUBLIC_BACKEND_URL}`);
  const isDevMode = await getDeveloperMode();

  if (__DEV__ && isDevMode) {
    const rawOverride = await getRawBackendOverride();
    console.log(`[Diagnostic] raw asyncStorage override: '${rawOverride}'`);
    const normalizedOverride = normalizeBaseUrl(rawOverride);

    // Only use if it's a valid http or https URL
    if (normalizedOverride && (normalizedOverride.startsWith('http://') || normalizedOverride.startsWith('https://'))) {
      console.log(`[Diagnostic] getBackendUrl: resolved baseUrl (override) -> ${normalizedOverride}`);
      return normalizedOverride;
    } else if (rawOverride) {
      console.log(`[Diagnostic] getBackendUrl: ignored invalid override -> ${rawOverride}`);
    }
  }

  console.log(`[Diagnostic] getBackendUrl: resolved baseUrl (default) -> ${DEFAULT_BACKEND_URL}`);
  return DEFAULT_BACKEND_URL;
}

export async function setBackendUrl(url: string): Promise<void> {
  await AsyncStorage.setItem(BACKEND_URL_KEY, normalizeBaseUrl(url));
}

/**
 * Temporary helper for debugging: safely resets the backend configuration
 * to ensure the app uses the environment default.
 */
export async function resetBackendConfigForDebug(): Promise<void> {
  await clearBackendOverride();
  await setDeveloperMode(false);
  console.log('[Diagnostic] Backend config reset: override cleared and developer mode disabled.');
}

export async function getAppSecret(): Promise<string> {
  const secret = await AsyncStorage.getItem(APP_SECRET_KEY);
  const trimmed = secret?.trim();
  // Fallback comes from build-time config, never a literal in the repo.
  // NOTE: any value here ships inside the JS bundle, so this is a speed bump,
  // not authentication. Real protection is server-side: rate limit +
  // per-device usage cap + RevenueCat receipt verification.
  return trimmed || process.env.EXPO_PUBLIC_APP_SECRET || '';
}

export async function setAppSecret(secret: string): Promise<void> {
  await AsyncStorage.setItem(APP_SECRET_KEY, secret.trim());
}

async function buildHeaders(): Promise<Record<string, string>> {
  return { 'x-app-key': await getAppSecret(), 'x-device-id': await getDeviceId() };
}

// ── Status checking ───────────────────────────────────────────────────────────
// React Native's XMLHttpRequest does not reliably populate error.response for
// multipart requests on 4xx responses. Using validateStatus:()=>true + manual
// status assertion ensures error.response is always set correctly.

function assertStatus(res: AxiosResponse): void {
  if (res.status >= 200 && res.status < 300) return;
  const err: any = new Error(`HTTP ${res.status}`);
  err.response = { status: res.status, data: res.data }; // always populated
  throw err;
}

// Never throw on any HTTP status — we check manually via assertStatus.
const ACCEPT_ALL = { validateStatus: () => true } as const;

// ── Error classification ──────────────────────────────────────────────────────

/**
 * Maps low-level axios/fetch errors into human-readable, actionable messages.
 * Call this any time a network operation fails instead of bubbling raw `err`.
 */
function classifyNetworkError(err: any, context: string): Error {
  // Already a classified error from assertStatus — preserve it.
  if (err?.response?.status) {
    const status: number = err.response.status;
    const body = JSON.stringify(err.response.data ?? {});
    
    // Graceful handling for silent audio chunks
    const isNoSpeech = body.includes('no spoken audio') || body.includes('language_detection cannot be performed');
    if (isNoSpeech) {
      console.log(`[${context}] Silent chunk detected (no spoken audio)`);
      const noSpeechErr = new Error(`[${context}] 오디오에 음성이 감지되지 않았습니다.`);
      (noSpeechErr as any).isNoSpeech = true;
      return noSpeechErr;
    }

    console.error(`[${context}] HTTP ${status} response body: ${body}`);
    if (status === 413) return new Error(`[${context}] 파일이 너무 큽니다 (413 Payload Too Large).`);
    if (status === 401 || status === 403) return new Error(`[${context}] 인증 실패 (${status}). 앱 시크릿 키를 확인해 주세요.`);
    if (status === 404) return new Error(`[${context}] 엔드포인트를 찾을 수 없습니다 (404).`);
    if (status === 422) return new Error(`[${context}] 잘못된 요청 형식 (422): ${body}`);
    if (status >= 500) return new Error(`[${context}] 서버 오류 (${status}). 잠시 후 다시 시도해 주세요.`);
    return new Error(`[${context}] 요청 실패 (HTTP ${status}): ${body}`);
  }

  const msg: string = err?.message ?? String(err);
  const code: string = err?.code ?? '';
  console.error(`[${context}] 네트워크 오류: code=${code} message=${msg}`);

  if (code === 'ECONNABORTED' || msg.toLowerCase().includes('timeout')) {
    return new Error(`[${context}] 요청 시간이 초과되었습니다. 네트워크 상태를 확인해 주세요.`);
  }
  if (code === 'ERR_NETWORK' || msg === 'Network Error') {
    return new Error(`[${context}] 네트워크에 연결할 수 없습니다. 인터넷 연결을 확인하거나 백엔드 서버 상태를 확인해 주세요.`);
  }
  if (code === 'ENOTFOUND' || code === 'ECONNREFUSED') {
    return new Error(`[${context}] 백엔드 서버에 연결할 수 없습니다 (${code}). URL을 확인해 주세요.`);
  }
  return new Error(`[${context}] ${msg}`);
}

/**
 * Validates the resolved backend URL before use.
 * Throws a clear error (not a confusing "Network Error") if the URL is empty or malformed.
 */
function assertBackendUrl(url: string, context: string): void {
  if (!url) {
    console.error(`[${context}] Backend URL is empty! Check EXPO_PUBLIC_BACKEND_URL in .env`);
    throw new Error(`[${context}] 백엔드 URL이 설정되지 않았습니다. .env 파일의 EXPO_PUBLIC_BACKEND_URL을 확인해 주세요.`);
  }
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    console.error(`[${context}] Backend URL is invalid: '${url}'`);
    throw new Error(`[${context}] 백엔드 URL이 올바르지 않습니다: '${url}'`);
  }
  console.log(`[${context}] Backend URL validated: ${url}`);
}

// ── Exported API functions ────────────────────────────────────────────────────
// These keep the exact same signatures as before so detail/[id].tsx is unchanged.

export class TranscriptionLimitError extends Error {}
let retryTranscriptionAt = 0;

export const transcribeAudio = quickTranscribe;

export async function quickTranscribe(
  audioUri: string,
  recognitionLanguage: RecognitionLanguage = 'auto'
): Promise<string> {
  if (Date.now() < retryTranscriptionAt) throw new TranscriptionLimitError('전사 한도에 도달했습니다. 나중에 다시 시도해 주세요.');
  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

  try {
    const info = await FileSystem.getInfoAsync(audioUri);
    if (info.exists && (info as any).size < 4000) {
      console.log(`[quickTranscribe] audio file too small (${(info as any).size} bytes) — assuming silent and skipping upload.`);
      return '';
    }
  } catch (err) {
    // Ignore and proceed
  }

  const baseUrl = await getBackendUrl();
  assertBackendUrl(baseUrl, 'quickTranscribe');

  const secret = await getAppSecret();
  if (!secret) {
    throw new Error('설정 → AI 서버 연결에서 앱 키를 입력해 주세요.');
  }

  const normalizedLanguage = normalizeRecognitionLanguage(recognitionLanguage);
  const languageQuery = buildLanguageQueryParam(normalizedLanguage);
  const endpoint = `${baseUrl}/api/transcribe/quick${languageQuery}`;
  console.log(`[quickTranscribe] ▶ uri=${audioUri} | endpoint=${endpoint}`);

  const formData = new FormData();
  formData.append('audio', {
    uri: audioUri,
    type: 'audio/m4a',
    name: 'quick_audio.m4a',
  } as unknown as Blob);
  formData.append('language', normalizedLanguage);

  try {
    const res = await axios.post(
      endpoint,
      formData,
      {
        headers: {
          'x-app-key': secret,
          'x-device-id': await getDeviceId(),
          'Content-Type': 'multipart/form-data',
        },
        // Allow time for the hosting service to wake up before transcription.
        timeout: 150_000,
        ...ACCEPT_ALL,
      }
    );
    if (res.status === 429) {
      const seconds = Number(res.headers['retry-after']);
      retryTranscriptionAt = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000;
      throw new TranscriptionLimitError('전사 한도에 도달했습니다. 나중에 다시 시도해 주세요.');
    }
    assertStatus(res);
    const text = res.data.text ?? '';
    console.log(`[quickTranscribe] ✅ done in ${elapsed()} | chars=${text.length}`);
    return text;
  } catch (err: any) {
    if (err instanceof TranscriptionLimitError) throw err;
    const classified = classifyNetworkError(err, 'quickTranscribe');
    
    if ((classified as any).isNoSpeech) {
      console.log(`[quickTranscribe] skipping silent chunk safely after ${elapsed()}`);
      return ''; // Gracefully exit without failure
    }

    throw classified;
  }
}

/**
 * Normalizes transcript text by removing common filler words, collapsing repetitions,
 * and cleaning up whitespace. This is meant to reduce token usage and noise for AI.
 */
function normalizeTranscript(text: string): string {
  if (!text) return '';

  let cleaned = text;

  // 1. Remove obvious fillers (case-insensitive for Latin, whole word where possible)
  // Korean fillers
  cleaned = cleaned.replace(/(?:^|\s)(?:음|어|그|저기|그게|이제|뭐)(?:\.{1,3}|\s|$)/g, ' ');

  // English fillers (um, uh, er, ah, etc.)
  cleaned = cleaned.replace(/\b(um|uh|er|ah|hmm)\b/gi, '');

  // 2. Collapse immediate word repetitions (e.g., "그래서 그래서" -> "그래서")
  // Only for common short words to avoid accidental meaning changes
  cleaned = cleaned.replace(/\b(\w{1,5})\s+\1\b/g, '$1');
  // Korean specific repetition (words ending with spaces/punctuation)
  cleaned = cleaned.replace(/([가-힣]{1,3})\s+\1\b/g, '$1');

  // 3. Normalize whitespace: collapse multiple spaces/newlines
  cleaned = cleaned.replace(/\s+/g, ' ').trim();

  return cleaned;
}

/**
 * Send transcript text to backend → backend calls OpenAI → return summary + suggested title.
 * Returns { summary, suggestedName } where suggestedName is a concise title (≤20 chars).
 * lectureType is passed to the backend to generate category-specific summaries.
 */
export async function summarizeText(
  text: string,
  lectureType: LectureType = 'general',
  language: string = 'ko',
  customInstruction: string = ''
): Promise<{ summary: any; suggestedName: string }> {
  const normalizedText = normalizeTranscript(text);
  const baseUrl = await getBackendUrl();
  const headers = await buildHeaders();

  if (!headers['x-app-key']) {
    throw new Error('앱 시크릿 키가 설정되지 않았습니다. 설정 탭에서 입력해 주세요.');
  }

  const res = await axios.post(
    `${baseUrl}/api/summarize`,
    { text: normalizedText, lectureType, language, customInstruction },
    // Chunked path for long lectures can take several minutes on the backend;
    // 5 min gives enough headroom even for 60-min recordings.
    { headers, timeout: 300_000, ...ACCEPT_ALL }
  );
  assertStatus(res);

  const data = res.data as { summary: string; suggestedName?: string };
  
  let parsedSummary: any = data.summary;
  if (typeof data.summary === 'string') {
    try {
      parsedSummary = JSON.parse(data.summary);
    } catch (err) {
      console.warn('[summarizeText] Failed to parse summary JSON, falling back to raw string', err);
    }
  }

  return {
    summary: parsedSummary,
    suggestedName: data.suggestedName ?? '',
  };
}

/**
 * Send transcript text to backend → backend calls OpenAI → return translation.
 */
export async function translateText(
  text: string,
  targetLang: string = 'en'
): Promise<string> {
  // Map language codes to full language names for OpenAI
  const langMap: Record<string, string> = {
    'en': 'English',
    'ko': 'Korean',
    'ja': 'Japanese',
    'zh': 'Chinese',
    'es': 'Spanish',
    'fr': 'French',
  };
  const fullLangName = langMap[targetLang] || 'English';
  const baseUrl = await getBackendUrl();
  const headers = await buildHeaders();

  if (!headers['x-app-key']) {
    throw new Error('앱 시크릿 키가 설정되지 않았습니다. 설정 탭에서 입력해 주세요.');
  }

  const res = await axios.post(
    `${baseUrl}/api/translate`,
    { text, targetLang: fullLangName },
    { headers, timeout: 90_000, ...ACCEPT_ALL }
  );
  assertStatus(res);

  return (res.data as { translation: string }).translation;
}

/**
 * Send text to backend → backend calls OpenAI → return short title string.
 */
export async function generateRecordingTitle(text: string): Promise<string> {
  console.log('[Diagnostic] generateRecordingTitle: resolving backend URL');
  const baseUrl = await getBackendUrl();
  const headers = await buildHeaders();

  if (!headers['x-app-key']) {
    console.log('[Diagnostic] generateRecordingTitle failed: No app secret');
    throw new Error('앱 시크릿 키가 설정되지 않았습니다. 설정 탭에서 입력해 주세요.');
  }

  const endpoint = `${baseUrl}/api/title`;
  console.log(`[Diagnostic] generateRecordingTitle: POST ${endpoint}`);

  const res = await axios.post(
    endpoint,
    { text },
    { headers, timeout: 30_000, ...ACCEPT_ALL }
  );

  console.log(`[Diagnostic] generateRecordingTitle: HTTP ${res.status}`);
  if (res.status !== 200) {
    console.log(`[Diagnostic] generateRecordingTitle error response: ${JSON.stringify(res.data)}`);
  }

  assertStatus(res);

  const finalTitle = (res.data as { title: string }).title;
  console.log(`[Diagnostic] generateRecordingTitle success: '${finalTitle}'`);
  return finalTitle;
}

/**
 * Send transcript text to backend → backend calls OpenAI → return quiz questions.
 * Returns an array of multiple-choice questions for self-testing.
 */
export async function generateQuiz(
  text: string,
  language: string = 'ko',
  count: number = 5
): Promise<import('@/store/useRecordingStore').QuizQuestion[]> {
  const baseUrl = await getBackendUrl();
  assertBackendUrl(baseUrl, 'generateQuiz');
  const headers = await buildHeaders();

  if (!headers['x-app-key']) {
    throw new Error('앱 시크릿 키가 설정되지 않았습니다. 설정 탭에서 입력해 주세요.');
  }

  let res;
  try {
    res = await axios.post(
      `${baseUrl}/api/quiz`,
      { text, language, count },
      { headers, timeout: 120_000, ...ACCEPT_ALL }
    );
    assertStatus(res);
  } catch (err: any) {
    throw classifyNetworkError(err, 'generateQuiz');
  }

  const quiz = (res.data as { quiz?: any[] }).quiz;
  if (!Array.isArray(quiz) || quiz.length === 0) {
    throw new Error('퀴즈를 생성하지 못했습니다. 다시 시도해 주세요.');
  }
  return quiz as import('@/store/useRecordingStore').QuizQuestion[];
}


export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Lecture-grounded chat: ask questions answered from the transcript context,
 * with general-knowledge supplementation clearly marked by the backend prompt.
 */
export async function chatWithLecture(
  transcript: string,
  messages: ChatMessage[],
  language: string = 'ko'
): Promise<string> {
  const baseUrl = await getBackendUrl();
  assertBackendUrl(baseUrl, 'chatWithLecture');
  const headers = await buildHeaders();

  if (!headers['x-app-key']) {
    throw new Error('앱 시크릿 키가 설정되지 않았습니다. 설정 탭에서 입력해 주세요.');
  }

  let res;
  try {
    res = await axios.post(
      `${baseUrl}/api/chat`,
      { text: transcript, messages, language },
      { headers, timeout: 90_000, ...ACCEPT_ALL }
    );
    assertStatus(res);
  } catch (err: any) {
    throw classifyNetworkError(err, 'chatWithLecture');
  }

  const reply = (res.data as { reply?: string }).reply;
  if (!reply) throw new Error('답변을 받지 못했습니다. 다시 시도해 주세요.');
  return reply;
}

/**
 * Generate topic chapters from time-aligned transcript segments.
 * Sends compact { startMs, text } segments → backend asks the LLM to group them
 * into chapters, returning [{ title, startMs }] mapped back to audio positions.
 */
export async function generateChapters(
  segments: import('@/store/useRecordingStore').TranscriptSegment[],
  language: string = 'ko'
): Promise<import('@/store/useRecordingStore').Chapter[]> {
  const baseUrl = await getBackendUrl();
  assertBackendUrl(baseUrl, 'generateChapters');
  const headers = await buildHeaders();

  if (!headers['x-app-key']) {
    throw new Error('앱 시크릿 키가 설정되지 않았습니다. 설정 탭에서 입력해 주세요.');
  }

  // Send a compact representation to keep the payload small.
  const compact = segments.map((s) => ({ startMs: Math.round(s.startMs), text: s.text }));

  let res;
  try {
    res = await axios.post(
      `${baseUrl}/api/chapters`,
      { segments: compact, language },
      { headers, timeout: 120_000, ...ACCEPT_ALL }
    );
    assertStatus(res);
  } catch (err: any) {
    throw classifyNetworkError(err, 'generateChapters');
  }

  const chapters = (res.data as { chapters?: any[] }).chapters;
  if (!Array.isArray(chapters) || chapters.length === 0) {
    throw new Error('챕터를 생성하지 못했습니다. 다시 시도해 주세요.');
  }
  // Sanitize + clamp to valid segment time range.
  const maxMs = segments.length ? segments[segments.length - 1].startMs : 0;
  return chapters
    .filter((c) => c && typeof c.title === 'string' && typeof c.startMs === 'number')
    .map((c) => ({ title: String(c.title).slice(0, 60), startMs: Math.max(0, Math.min(c.startMs, maxMs)) }))
    .sort((a, b) => a.startMs - b.startMs);
}
