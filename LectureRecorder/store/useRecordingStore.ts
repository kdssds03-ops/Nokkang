import { useSettingsStore } from './useSettingsStore';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { create } from 'zustand';

export interface Folder {
  id: string;
  name: string;
  createdAt: number;
}

export type LectureType =
  | 'general'
  | 'math'
  | 'science'
  | 'coding'
  | 'humanities'
  | 'language'
  | 'history'
  | 'economics'
  | 'law'
  | 'medicine'
  | 'art'
  | 'other';

export const LECTURE_TYPE_LABELS: Record<LectureType, string> = {
  general: '일반',
  math: '수학',
  science: '과학',
  coding: '코딩 / 프로그래밍',
  humanities: '인문학',
  language: '어문학 / 언어',
  history: '역사',
  economics: '경제 / 경영',
  law: '법학',
  medicine: '의학 / 생명과학',
  art: '예술 / 디자인',
  other: '기타',
};

export const LECTURE_TYPE_ICONS: Record<LectureType, string> = {
  general: '📚',
  math: '📐',
  science: '🔬',
  coding: '💻',
  humanities: '🧠',
  language: '🗣️',
  history: '🏛️',
  economics: '📊',
  law: '⚖️',
  medicine: '🩺',
  art: '🎨',
  other: '📝',
};

export interface StructuredSummary {
  lectureType?: string;
  overview: string;
  keyPoints: string[];
  details: { heading: string; content: string }[];
  keywords: string[];
  studyTips: string;
}

export function isStructuredSummary(summary: any): summary is StructuredSummary {
  return typeof summary === 'object' && summary !== null && 'overview' in summary;
}

export interface QuizQuestion {
  question: string;
  options: string[];
  answerIndex: number;
  explanation?: string;
}

export interface Chapter {
  title: string;
  startMs: number;
}

/** A piece of transcript with the audio position where it starts. */
export interface TranscriptSegment {
  startMs: number;
  text: string;
}

export interface LectureChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface RecordingMeta {
  id: string;
  name: string;
  titleSource?: 'default' | 'ai' | 'user';
  uri: string;
  chunkUris?: string[];
  chunkDurations?: number[];
  duration: number; // in milliseconds
  createdAt: number;
  folderId: string | null;  // which folder this recording belongs to
  lectureType?: LectureType;
  transcript?: string;
  transcriptIncomplete?: boolean;
  summary?: string | StructuredSummary;
  translation?: string;
  isSummarizing?: boolean;
  /** Time-aligned transcript pieces (one per 30s recording chunk). Absent on older recordings. */
  segments?: TranscriptSegment[];
  quiz?: QuizQuestion[];
  chapters?: Chapter[];
  chat?: LectureChatMessage[];
}

interface RecordingStore {
  recordings: RecordingMeta[];
  addRecording: (recording: RecordingMeta) => void;
  removeRecording: (id: string) => Promise<void>;
  updateRecording: (id: string, data: Partial<RecordingMeta>) => void;
  moveToFolder: (recordingId: string, folderId: string | null) => void;
  loadRecordings: () => Promise<void>;
  fetchSummary: (recordingId: string) => Promise<void>;
  _hasHydrated: boolean;
}

export const useRecordingStore = create<RecordingStore>((set, get) => ({
  recordings: [],
  _hasHydrated: false,

  addRecording: (recording) => {
    const updated = [recording, ...get().recordings];
    set({ recordings: updated });
    AsyncStorage.setItem('recordings', JSON.stringify(updated));
  },

  removeRecording: async (id) => {
    const target = get().recordings.find((r) => r.id === id);

    for (const uri of new Set([target?.uri, ...(target?.chunkUris ?? [])])) {
      if (!uri) continue;
      try {
        const info = await FileSystem.getInfoAsync(uri);
        if (info.exists) {
          await FileSystem.deleteAsync(uri, { idempotent: true });
        }
      } catch (err) {
        console.warn(`[store] Could not delete audio file for recording ${id}:`, err);
      }
    }

    const updated = get().recordings.filter((r) => r.id !== id);
    set({ recordings: updated });
    AsyncStorage.setItem('recordings', JSON.stringify(updated));
  },

  updateRecording: (id, data) => {
    const updated = get().recordings.map((r) => (r.id === id ? { ...r, ...data } : r));
    set({ recordings: updated });
    AsyncStorage.setItem('recordings', JSON.stringify(updated));
  },

  moveToFolder: (recordingId, folderId) => {
    const updated = get().recordings.map((r) =>
      r.id === recordingId ? { ...r, folderId } : r
    );
    set({ recordings: updated });
    AsyncStorage.setItem('recordings', JSON.stringify(updated));
  },

  loadRecordings: async () => {
    const recData = await AsyncStorage.getItem('recordings');
    set({
      recordings: recData ? JSON.parse(recData) : [],
      _hasHydrated: true,
    });
  },

  fetchSummary: async (recordingId: string) => {
    const { recordings, updateRecording } = get();
    const recording = recordings.find(r => r.id === recordingId);

    if (!recording || !recording.transcript) return;

    // Set loading state
    updateRecording(recordingId, { isSummarizing: true });

    try {
      const { summarizeText } = require('@/api/aiService');
      const { summary, suggestedName } = await summarizeText(recording.transcript, recording.lectureType || 'general', useSettingsStore.getState().summaryLanguage);

      const updates: Partial<RecordingMeta> = {
        summary,
        isSummarizing: false
      };

      if (suggestedName && suggestedName.trim() !== '' && get().recordings.find(r => r.id === recordingId)?.titleSource !== 'user') {
        updates.name = suggestedName;
        updates.titleSource = 'ai';
      }

      updateRecording(recordingId, updates);

    } catch (error) {
      updateRecording(recordingId, { isSummarizing: false });
      throw error;
    }
  },
}));
