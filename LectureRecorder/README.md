# 🎙️ 노깡 (LectureRecorder)

> 강의 내용을 녹음하고, 실시간으로 전사하고, AI가 강의 종류에 맞게 구조화된 요약을 생성하는 모바일 앱

---

## 📌 Overview

**노깡**은 강의나 발표 내용을 더 효율적으로 기록하고 복습할 수 있도록 만든 앱입니다.

단순히 음성을 녹음하는 데서 끝나는 것이 아니라,

- 녹음 시작 전 **강의 종류를 선택**하여 AI 요약을 최적화하고
- 녹음 중 **30초 단위로 실시간 전사** 내용을 확인하고
- 녹음 완료 후 **강의 종류별 구조화된 AI 요약 노트**를 생성하며

학습 효율을 극대화하는 것을 목표로 합니다.

---

## ✨ Features

- 🎤 강의 음성 녹음 (백그라운드 지원)
- 📚 강의 종류 선택 (수학, 코딩, 인문학, 역사 등 12가지)
- ⏱️ 녹음 중 30초 단위 실시간 전사 표시
- 📂 녹음 파일 폴더별 저장 및 목록 관리
- ▶️ 녹음 파일 재생 (배속 조절 지원)
- 📝 음성 텍스트 변환 (STT, Groq)
- 🤖 강의 종류별 구조화된 AI 요약 노트 (개요, 핵심 포인트, 키워드, 학습 팁)
- ⚙️ 설정 관리

---

## 🛠 Tech Stack

### Frontend (Mobile App)
- React Native + Expo (SDK 54)
- Expo Router (File-based routing)
- TypeScript
- Zustand (State management)
- expo-av (Audio recording & playback)

### Backend API (`lecture-api/`)
- Node.js + Express
- TypeScript
- Groq (Speech-to-text)
- Groq Qwen (Summarization)

### Deployment
- Mobile: EAS Build (Expo Application Services)
- Backend: Render 무료 Web Service

---

## 📁 Project Structure

```
LectureRecorder/
├── app/                    # 앱 화면 (Expo Router)
│   ├── (tabs)/index.tsx    # 홈 화면 (녹음 목록)
│   ├── record.tsx          # 녹음 화면 (강의 종류 선택 + 실시간 전사)
│   ├── detail/[id].tsx     # 상세 화면 (전사 / 구조화 요약)
│   ├── settings.tsx        # 설정 화면
│   └── _layout.tsx         # 루트 레이아웃
├── api/
│   └── aiService.ts        # AI API 클라이언트
├── store/
│   ├── useRecordingStore.ts # 녹음 상태 관리
│   ├── useSettingsStore.ts  # 설정 상태 관리
│   └── useFolderStore.ts   # 폴더 상태 관리
├── lecture-api/            # 백엔드 Express 서버
│   └── src/
│       ├── index.ts        # 서버 엔트리포인트
│       ├── config.ts       # 환경변수 설정
│       └── routes/
│           ├── transcribe.ts  # 음성 인식 API
│           └── summarize.ts   # AI 요약 API
├── components/             # 공통 UI 컴포넌트
├── constants/              # 디자인 시스템 (Colors, theme)
├── assets/                 # 이미지 및 정적 리소스
├── .env                    # 환경변수 (EXPO_PUBLIC_BACKEND_URL)
├── app.json                # Expo 앱 설정
└── eas.json                # EAS 빌드 설정
```

---

## 🚀 Getting Started

### Prerequisites

- Node.js 18+
- Expo CLI (`npm install -g expo-cli`)
- EAS CLI (`npm install -g eas-cli`)

### Frontend Setup

```bash
# 의존성 설치
npm install

# iOS 시뮬레이터에서 로컬 API 사용 (실기기는 컴퓨터의 LAN 주소 사용)
EXPO_PUBLIC_BACKEND_URL=http://localhost:3000 npx expo start
```

### Backend Setup

```bash
cd lecture-api

# 의존성 설치
npm install

# 환경변수 설정 (.env 파일 생성)
echo "GROQ_API_KEY=your_groq_key" >> .env
echo "APP_SECRET=your_app_secret" >> .env

# 빌드 후 시작
npm run build && node --env-file=.env dist/index.js

# Node.js 20.6 이상에서 .env를 읽어 실행합니다.
```

앱의 **설정 → AI 서버 연결**에서 같은 `APP_SECRET`을 입력합니다. 전사와 요약에는 같은 Groq 키를 사용합니다.

### Render 배포

1. Render에서 **New → Blueprint**로 GitHub 저장소와 배포 브랜치를 연결합니다. 저장소 루트의 `render.yaml`이 `LectureRecorder/lecture-api`를 무료 Web Service로 배포합니다.
2. Render 대시보드에서 `GROQ_API_KEY`를 입력합니다. Render가 생성한 `APP_SECRET`은 내부 테스트 앱의 **설정 → AI 서버 연결**에서 입력합니다.
3. 발급된 HTTPS 주소의 `/health`가 HTTP 200을 반환하는지 확인합니다. 이어서 내부 테스트 앱에서 짧은 강의의 전사와 요약을 확인합니다.
4. Expo 대시보드에서 배포할 EAS 환경의 `EXPO_PUBLIC_BACKEND_URL`에 발급된 주소를 설정하고 새 빌드를 만듭니다. `preview`와 `production`은 각각 설정합니다.

무료 서비스는 유휴 상태에서 잠들 수 있습니다. 앱에 공개되는 환경 변수에는 서버 URL만 저장하고 AI 키와 테스트용 앱 키는 서버에서 관리합니다.

### Environment Variables

| 변수명 | 설명 | 위치 |
|--------|------|------|
| `EXPO_PUBLIC_BACKEND_URL` | 백엔드 서버 URL | `.env` (앱) |
| `GROQ_API_KEY` | Groq API 키 | 백엔드 환경변수 |
| `APP_SECRET` | 앱 인증 시크릿 | 백엔드 환경변수 |

---

## 📱 Building for Production

```bash
# iOS 빌드
eas build --platform ios --profile production

# Android 빌드
eas build --platform android --profile production

# App Store 제출
eas submit --platform ios
```

---

## 🗂️ Lecture Types

강의 종류 선택 시 AI가 해당 분야에 최적화된 요약을 생성합니다:

| 아이콘 | 종류 | 특화 요약 항목 |
|--------|------|----------------|
| 📚 | 일반 | 핵심 내용, 주요 포인트 |
| 📐 | 수학 | 공식, 정리, 풀이 방법론 |
| 🔬 | 과학 | 법칙, 실험, 과학적 원리 |
| 💻 | 코딩/프로그래밍 | 알고리즘, 자료구조, 구현 방법 |
| 🧠 | 인문학 | 사상, 논증, 철학적 개념 |
| 🗣️ | 어문학/언어 | 언어 규칙, 문법, 표현 |
| 🏛️ | 역사 | 사건, 연도, 인물, 인과관계 |
| 📊 | 경제/경영 | 이론, 모델, 경제 지표 |
| ⚖️ | 법학 | 법 조항, 판례, 법적 원칙 |
| 🩺 | 의학/생명과학 | 의학 개념, 병리, 치료법 |
| 🎨 | 예술/디자인 | 예술 개념, 기법, 작가 |
| 📝 | 기타 | 일반 요약 |
