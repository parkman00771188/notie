# Gimnote — 로컬 AI 회의록 웹앱 설계 명세 (구현 계약서)

모든 구현 에이전트는 이 문서와 이미 작성된 뼈대 파일(`frontend/src/types.ts`, `frontend/src/api.ts`,
`frontend/src/utils.ts`, `frontend/src/styles/global.css`, `frontend/src/App.tsx`,
`backend/app/config.py`, `backend/app/db.py`, `backend/app/main.py`)을 **정확히** 따른다.
뼈대 파일은 수정하지 않는다 (버그가 아닌 한).

## 제품 개요
음성 녹음 → Whisper 로컬 STT → 요약(핵심 요약/결정 사항/할 일) → 회의록(마크다운) 자동 생성.
녹음 중 실시간 메모/북마크, 참석자 라벨 관리, 최근 회의 패널 및 전체 보기 모달.

언어: UI 텍스트는 전부 한국어. 코드 식별자는 영어.

## 아키텍처
- `frontend/` — React 18 + Vite + TS. dev 서버 5173, `/api` 프록시 → 127.0.0.1:8000.
- `backend/` — FastAPI + SQLite(`data/gimnote.db`), 오디오 파일은 `data/audio/`.
- STT: `faster-whisper` (지연 로딩 싱글턴, config.WHISPER_MODEL 기본 "small", language "ko").
- 요약: Ollama(127.0.0.1:11434) 가능하면 사용, 실패 시 한국어 휴리스틱 추출 요약 폴백.

## 회의 상태 머신 (MeetingStatus)
`recording`(녹음 중) → `queued`(대기 중) → `transcribing`(변환 중) → `summarizing`(요약 중) → `done`(요약 완료) | `failed`(실패)

배지 매핑(StatusBadge): recording=빨강 "녹음 중", queued=회색 "대기 중", transcribing=파랑 "변환 중",
summarizing=파랑 "요약 중", done=초록 "요약 완료", failed=빨강 "실패".

## DB 스키마
`backend/app/db.py`에 이미 정의됨. 테이블: users, sessions, participants, meetings,
meeting_participants, bookmarks, transcript_segments, summaries. 라우터는 `db.get_conn()`으로
커넥션을 얻고(with 문 사용 가능), 모든 조회는 현재 로그인 user_id로 스코프한다.

## REST API (모두 `/api` 프리픽스, 인증 필요 — auth 제외)
인증: `Authorization: Bearer <token>` 헤더 또는 `?token=` 쿼리 파라미터(오디오 스트리밍용).
실패 시 401 `{"detail": "..."}`.

### auth (`routers/auth.py`)
- `POST /api/auth/signup` `{email, password, name, team?}` → `{token, user}` (이메일 중복 시 400 "이미 가입된 이메일입니다")
- `POST /api/auth/login` `{email, password}` → `{token, user}` (실패 시 401 "이메일 또는 비밀번호가 올바르지 않습니다")
- `GET /api/auth/me` → `user`
- `POST /api/auth/logout` → `{ok: true}` (세션 삭제)

user 응답 형태: `{id, email, name, team}`.

### participants (`routers/participants.py`) — 사용자별 참석자 사전(디렉터리)
- `GET /api/participants` → `Participant[]`
- `POST /api/participants` `{name, role?, color?}` → `Participant` (color 미지정 시 팔레트에서 순환 자동 배정)
- `PATCH /api/participants/{id}` `{name?, role?, color?}` → `Participant`
- `DELETE /api/participants/{id}` → `{ok: true}`

색 팔레트(자동 배정 순환): `["#2563eb", "#e8590c", "#0ca678", "#7048e8", "#d6336c", "#f08c00", "#1098ad", "#5f3dc4"]`

### meetings (`routers/meetings.py`)
- `POST /api/meetings` `{title, tag?, participant_ids?: number[]}` → `Meeting` (status "recording", started_at 서버 now ISO)
- `GET /api/meetings?q=<검색어>` → `Meeting[]` (created_at DESC, q는 title LIKE 검색)
- `GET /api/meetings/{id}` → `MeetingDetail` (participants, bookmarks(time_sec ASC), segments(start_sec ASC), summary 포함)
- `PATCH /api/meetings/{id}` `{title?, tag?, participant_ids?}` → `Meeting` (participant_ids가 오면 전체 교체)
- `DELETE /api/meetings/{id}` → `{ok: true}` (오디오 파일도 삭제)
- `POST /api/meetings/{id}/audio` multipart: `file`(UploadFile), `duration_sec`(Form, float) →
  `data/audio/meeting_{id}.webm`(파일 content_type에 따라 확장자, 기본 .webm) 저장,
  meeting에 duration_sec/audio_filename 기록, status='queued', `pipeline.enqueue(id)` 호출 → `Meeting`
- `GET /api/meetings/{id}/audio` → FileResponse (media_type 추정, 쿼리 token 인증 허용)
- `GET /api/meetings/{id}/status` → `{status, error_message}`
- `POST /api/meetings/{id}/summarize` → 요약 재실행: segments가 있으면 status='summarizing' 후 enqueue_summary(id) → `{ok: true}`; 없으면 400

Meeting 응답 형태 (types.ts의 `Meeting`과 일치):
```json
{"id":1,"title":"...","tag":null,"status":"done","started_at":"2026-07-06T10:00:00",
 "duration_sec":1815.2,"audio_filename":"meeting_1.webm","created_at":"...",
 "participants":[{"id":1,"name":"김지민","role":"디자이너","color":"#2563eb"}]}
```

### bookmarks (`routers/bookmarks.py`)
- `POST /api/meetings/{id}/bookmarks` `{time_sec, title, note?}` → `Bookmark`
- `GET /api/meetings/{id}/bookmarks` → `Bookmark[]` (time_sec ASC)
- `PATCH /api/bookmarks/{id}` `{title?, note?, time_sec?}` → `Bookmark`
- `DELETE /api/bookmarks/{id}` → `{ok: true}`
(북마크 소유권은 meeting → user_id 조인으로 검증)

## 백엔드 서비스 계약

### `services/stt.py`
- `transcribe(audio_path: str) -> list[dict]` — `[{"start": float, "end": float, "text": str}, ...]`
- faster-whisper `WhisperModel(config.WHISPER_MODEL, device="cpu", compute_type="int8")` 모듈 싱글턴(스레드 락, 지연 로딩).
- `model.transcribe(path, language=config.LANGUAGE, vad_filter=True)`; text는 strip, 빈 세그먼트 제외.
- import 실패(`faster_whisper` 미설치) 시 명확한 한국어 RuntimeError.

### `services/summarizer.py`
- `summarize(meeting: dict, segments: list[dict], bookmarks: list[dict], participants: list[dict]) -> dict`
  반환: `{"key_points": [str], "decisions": [str], "action_items": [{"text": str, "owner": str|None, "due": str|None}], "minutes_md": str, "engine": str}`
- 1차: Ollama. `GET {OLLAMA_URL}/api/tags` (timeout 2s)로 가용성 확인, `config.OLLAMA_MODEL` 또는 첫 번째 모델 사용.
  `POST /api/chat` (stream=False, format="json", timeout 300s)으로 한국어 프롬프트 → JSON 파싱. engine=`"ollama:<model>"`.
- 실패/미설치 시 추출 요약 폴백(engine="extractive"):
  - 문장 분리(정규식: `(?<=[.!?다요죠음됨함])\s+` 근사 + 개행), 너무 짧은(<10자) 문장 제외.
  - key_points: 단어 빈도 기반 상위 3~5문장(원문 순서 유지).
  - decisions: `결정|확정|하기로|승인|합의|채택|진행하기로` 패턴 문장.
  - action_items: `해야|할 일|까지|담당|예정|부탁|준비|공유하기로` 패턴 문장 → `{"text": 문장, "owner": None, "due": None}`.
  - 각 항목 최대 5개, 중복 제거.
- `minutes_md`(두 엔진 공통, 폴백 시 직접 생성): 마크다운 회의록 —
  `# <제목>` / `**일시**·**참석자**·**소요 시간**` / `## 핵심 요약` 불릿 / `## 결정 사항` 체크박스 `- [x]` /
  `## 액션 아이템` `- [ ]` / `## 타임라인` (북마크: `- **HH:MM:SS** — 제목`) / `## 상세 내용` (요약 문단).

### `services/pipeline.py`
- 모듈 레벨 `ThreadPoolExecutor(max_workers=1)` (Whisper 동시 실행 방지).
- `enqueue(meeting_id: int)`: 잡 제출. 잡 내부: status='transcribing' → stt.transcribe → 기존 세그먼트 삭제 후 삽입
  → status='summarizing' → summarizer.summarize → summaries upsert → status='done'.
  예외 시 status='failed', error_message 저장(로그 출력 포함).
- `enqueue_summary(meeting_id: int)`: 요약 단계만 재실행.
- 세그먼트가 0개면(무음) 요약은 빈 배열 + minutes_md에 "인식된 음성이 없습니다" 안내로 정상 완료(done).

### `auth_utils.py`
- `hash_password(pw)` / `verify_password(pw, h)` — stdlib `hashlib.pbkdf2_hmac` (sha256, 100k iter), 포맷 `pbkdf2$<iter>$<salt_hex>$<hash_hex>`.
- `create_session(conn, user_id) -> token` — `secrets.token_hex(24)`, sessions 삽입.
- `get_current_user(request: Request) -> dict` — FastAPI Depends용. Bearer 헤더 → 없으면 `token` 쿼리. sessions 조인으로 user dict `{id,email,name,team}` 반환, 실패 시 HTTPException(401).

## 프론트엔드 계약

라우팅(App.tsx에 이미 정의): `/auth`(AuthPage), 로그인 필요: `/`(HomePage), `/meetings`(MeetingsPage),
`/meetings/:id`(MeetingDetailPage), `/record`(RecordPage). Layout이 Sidebar + Outlet 렌더.
`useAuth()` (App.tsx에서 export): `{user, setUser, logout}`.

api.ts의 함수 시그니처를 그대로 사용한다(수정 금지). utils.ts의 `formatClock`, `formatDuration`,
`formatKoreanDateTime`, `formatRelativeDate`, `STATUS_LABEL`, `STATUS_TONE` 사용.

### 공용 컴포넌트 (`src/components/`) — 담당: fe-shell
- `Modal.tsx`: `{open: boolean; title?: string; width?: number; onClose: () => void; children: ReactNode}`
  — 오버레이 클릭/ESC로 닫기, 중앙 카드(radius-lg, shadow-pop), 헤더에 제목 + X 버튼. `createPortal` 사용.
- `StatusBadge.tsx`: `{status: MeetingStatus}` — 위 배지 매핑, global.css의 `.badge` 계열 클래스 사용.
- `Avatar.tsx`: `{name: string; color?: string; size?: number}` — 이름 첫 글자 원형 아바타(배경 color 연하게, 글자 color).
  `AvatarStack`: `{participants: Participant[]; max?: number}` — 겹친 아바타 + `+N`.
- `Sidebar.tsx`: 로고(`/logo.png` + "Gimnote" 워드마크), 파란 `+ 새 회의 기록` 버튼(→ `/record`),
  네비: 홈(`/`), 회의 목록(`/meetings`), 회의 기록(`/record`) — NavLink 활성 스타일(연파랑 배경 + 파랑 텍스트).
  하단 사용자 카드: Avatar + 이름/팀 + ▾ 클릭 시 드롭다운(로그아웃). `useAuth()` 사용.
- `Layout.tsx`: `<div class="layout"><Sidebar/><main><Outlet/></main></div>`.
- `RecentMeetingsPanel.tsx`: props `{refreshKey?: number}` — 최근 회의 카드(우측 320px 패널).
  헤더 "최근 회의" + "전체 보기" 링크 버튼 → **Modal 팝업**으로 전체 회의 목록(검색 인풋 포함, 행 클릭 시 해당 회의 상세로 navigate).
  목록 아이템: 제목(파일명 느낌), StatusBadge, `formatRelativeDate(started_at)` · `formatClock(duration_sec)`.
  최근 6개 표시. 하단에 AI 요약 프로모 카드(✨ "회의를 더 빠르게 정리해보세요" + "AI 요약 사용하기 →" — `/meetings`로 이동).
- `ParticipantPicker.tsx`: `{open: boolean; onClose: () => void; selected: Participant[]; onChange: (p: Participant[]) => void}`
  — Modal 기반 팝업. 등록된 참석자를 **라벨 칩**(참석자 color의 테두리+텍스트, 선택 시 연한 배경)으로 나열, 클릭 토글.
  하단 "새 참석자 추가" 인라인 폼(이름 + 직함/역할 인풋 + 추가 버튼) → `api.createParticipant` 후 목록 갱신 + 자동 선택.
  참석자 칩에 hover 시 삭제(×)로 디렉터리에서 제거(`api.deleteParticipant`).

### 녹음 (`fe-record` 담당)
- `hooks/useRecorder.ts`: `useRecorder()` →
  `{status: 'idle'|'recording'|'paused'|'stopped', elapsedSec: number, analyser: AnalyserNode|null,
    start(): Promise<void>, pause(): void, resume(): void, stop(): Promise<{blob: Blob, durationSec: number}>}`
  — getUserMedia audio, `MediaRecorder`(audio/webm), AudioContext+AnalyserNode(fftSize 256),
  elapsedSec는 pause 제외 실경과(250ms 인터벌). stop 시 스트림/컨텍스트 정리.
- `components/Waveform.tsx`: `{analyser: AnalyserNode|null; active: boolean; marks: {timeSec: number; label: string}[]; elapsedSec: number}`
  — canvas에 라이브 막대 파형(최근 N개 진폭 히스토리 유지, 파랑 막대). 파형 위에 북마크 핀(🔖 시간 라벨 칩) 표시.
- `pages/RecordPage.tsx` — 스크린샷 2 재현:
  - 헤더: 제목 인라인 편집(연필 아이콘, 기본값 "새 회의 기록"), 메타 행(날짜, 회의 시간, 태그 칩 — 태그 클릭 편집),
    AvatarStack + "참석자 N명" + `+ 추가` → ParticipantPicker 팝업.
  - 레코더 카드: 🔴 "녹음 중"/"일시정지됨", 큰 타이머(`formatClock`), Waveform, 버튼: 일시정지/재개, 종료(빨강), 마크 추가.
  - 시작 전에는 큰 "녹음 시작" 버튼. 시작 시 `api.createMeeting({title, tag, participant_ids})` → meetingId 확보.
  - **메모 입력**: 인풋 placeholder "회의 중 메모를 입력하세요..." + 파란 `+ 메모 추가` 버튼. **Enter 또는 버튼** →
    현재 elapsedSec에 북마크 생성(`api.addBookmark(meetingId, {time_sec, title: 입력텍스트})`), 인풋 클리어.
  - **마크 추가** 버튼: 텍스트 없이 현재 시간 북마크(title `"마크 N"`).
  - 메모 리스트: 시간 칩(파랑) + 제목 + ⋯ 메뉴(수정 = prompt 또는 인라인, 삭제). time ASC.
  - 종료: `stop()` → `api.uploadAudio(meetingId, blob, durationSec)` → `/meetings/:id`로 navigate.
  - 우측: `RecentMeetingsPanel`. 전체 2-컬럼 레이아웃(메인 flex-1 + 320px).
  - 페이지 이탈 시(녹음 중) beforeunload 경고.

### 페이지 (`fe-pages` 담당)
- `HomePage.tsx`: 인사말("안녕하세요, {이름}님 👋"), 통계 카드 3개(전체 회의 수, 요약 완료 수, 총 녹음 시간),
  "새 회의 기록" CTA, 최근 회의 카드 그리드(클릭 → 상세). 우측 RecentMeetingsPanel은 없음(전폭).
- `MeetingsPage.tsx`: 제목 "회의 목록", 검색 인풋(제목 검색, api.listMeetings(q) 디바운스 300ms),
  회의 행 리스트: 제목, StatusBadge, 날짜(formatKoreanDateTime), 시간(formatClock), AvatarStack, 삭제 버튼(확인 후 api.deleteMeeting).
  행 클릭 → `/meetings/:id`. 비어 있으면 빈 상태 안내 + 녹음 시작 버튼.
- `MeetingDetailPage.tsx`:
  - 헤더: 제목 인라인 편집(연필), 메타(날짜/시간/태그), AvatarStack + 참석자 편집(ParticipantPicker 재사용, PATCH participant_ids).
  - status가 done/failed가 아니면 3초 폴링(getMeeting) + 진행 배너("음성을 텍스트로 변환하고 있어요..." 등 상태별 문구, 스피너).
  - 오디오 플레이어: `<audio controls src={api.audioUrl(id)}>` + 북마크 칩 리스트(클릭 → currentTime 점프).
  - 탭: **AI 요약**(핵심 요약 불릿 / 결정 사항 ✅ / 할 일 ☐ / 사용 엔진 표기), **회의록**(marked로 minutes_md 렌더 + "복사" 버튼),
    **전체 스크립트**(세그먼트: 시간 칩 클릭 시 오디오 점프 + 텍스트), **메모**(북마크 목록, 클릭 점프, 수정/삭제).
  - "요약 다시 생성" 버튼(api.resummarize 후 폴링 재개), failed 시 error_message 표시 + 재시도.
- 각 페이지는 자기 전용 CSS 파일(`XxxPage.css`)을 만들어 import. 전역 클래스(global.css) 우선 활용.

### AuthPage (`fe-auth` 담당)
스크린샷 1 재현 — 좌우 2컬럼(1100px 컨테이너):
- 좌: 칩 배지 "✦ AI 회의록 도우미", 헤드라인 "녹음하면,\n요약과 회의록이\n자동으로 완성됩니다"(굵게, 3줄),
  서브카피 "회의의 모든 순간을 놓치지 않고,\nGimnote가 깔끔하게 정리해드려요.",
  일러스트: 정적 미니 카드 3개(회의 녹음 중… 파형/일시정지·정지 버튼, 회의 요약 카드(핵심 요약 불릿/결정 사항 체크), 요약 완료/회의록 생성/할 일 추출 미니 칩 카드) — CSS로만 구성, 점선 화살표 장식.
- 우: 카드 — 탭(로그인/회원가입, 밑줄 활성), 이메일/비밀번호(비밀번호 표시 토글 👁), 회원가입 탭엔 이름/팀 추가,
  "로그인 상태 유지" 체크박스 + "비밀번호를 잊으셨나요?"(alert "로컬 버전에서는 지원되지 않아요"),
  파란 제출 버튼, "또는" 구분선, Google/Apple 버튼(alert 동일), 하단 약관 문구.
- 성공 시 `setUser(res.user)` (api가 토큰 저장) → `navigate('/')`. 에러 메시지는 카드 상단 빨간 박스.
- 로고: 상단 좌측 `/logo.png` + Gimnote.

## 설정 & Gemini 요약 엔진 (추가 기능)

요약 엔진 우선순위: **Gemini(키 등록 시) → Ollama → 내장 추출 요약** (각 단계 실패 시 다음으로 폴백).
Gemini API 키는 `app_settings` 테이블(key='gemini_api_key') 또는 환경변수 `GIMNOTE_GEMINI_API_KEY`(DB 우선).

### settings API (`routers/settings.py`, prefix `/api/settings`, 인증 필요)
- `GET ""` → `{gemini_api_key_set: bool, gemini_key_preview: "...abcd"|null, gemini_model, ollama_available: bool}`
  (preview는 키 마지막 4자, ollama_available은 /api/tags 1.5초 체크)
- `PUT ""` `{gemini_api_key?: str}` → 키 upsert(공백 trim), 빈 문자열이면 삭제 → GET과 동일 응답
- `POST "/test-gemini"` → 등록된 키로 generateContent 미니 호출(timeout 15s) → `{ok: bool, message: str}` (성공: 모델명 포함, 실패: 원인 요약 — HTTP 4xx면 "API 키가 올바르지 않아요" 등 한국어)

### summarizer Gemini 엔진
- `POST {GEMINI_BASE_URL}/models/{GEMINI_MODEL}:generateContent?key=...`
  body: `{"contents":[{"parts":[{"text": 프롬프트}]}], "generationConfig":{"response_mime_type":"application/json"}}`
- 프롬프트: 한국어 회의 스크립트(+북마크/참석자 컨텍스트) → JSON `{key_points:[], decisions:[], action_items:[{text,owner,due}], detail: "상세 내용 문단"}` 요구
- engine=`"gemini:<model>"`. 응답 파싱은 방어적으로, 실패 시 Ollama → extractive 폴백. minutes_md는 공용 빌더 재사용(detail 문단을 상세 내용 섹션에 사용).

### 프론트 설정 UI
- `components/SettingsModal.tsx` `{open: boolean; onClose: () => void}` — "설정" Modal:
  현재 엔진 상태 배지(Gemini 연결됨(...abcd)/Ollama 사용 가능/내장 추출 요약), Gemini API 키 입력(password + 표시 토글),
  저장/연결 테스트/키 삭제 버튼, 결과 메시지, 발급 안내(aistudio.google.com/apikey, 키는 로컬 DB에만 저장).
- Sidebar 사용자 드롭다운에 "⚙️ 설정" 항목 → SettingsModal.
- MeetingDetailPage: summary.engine이 'extractive'면 힌트 문구("설정에서 Gemini API 키를 등록하면 더 정확한 AI 요약을 받을 수 있어요").

## 오디오 파일 업로드 (추가 기능)

녹음 대신 기존 오디오 파일(mp3/m4a/wav/webm/ogg)을 업로드해 같은 파이프라인(STT→요약)을 태운다.

### 백엔드
- `POST /api/meetings/{id}/audio`: 확장자 결정 시 content_type 매핑에 더해 **업로드 파일명 suffix 폴백** 지원
  (audio/mpeg→.mp3, audio/mp4|x-m4a→.m4a, audio/wav|x-wav→.wav, audio/ogg→.ogg, audio/webm→.webm, 그 외 파일명 확장자, 최종 기본 .webm).
- `pipeline.py`: 변환 완료 후 meeting.duration_sec이 NULL/0이면 마지막 세그먼트 end_sec으로 갱신
  (브라우저가 duration을 못 읽는 포맷 대비).

### 프론트
- `components/UploadModal.tsx` `{open: boolean; onClose: () => void}` — "오디오 파일 업로드" Modal:
  파일 선택 영역(클릭 + 드래그&드롭, accept="audio/*,.mp3,.m4a,.wav,.webm,.ogg"), 선택 시 파일명/크기 표시 +
  HTMLAudioElement(createObjectURL)로 duration 미리 읽기(실패 시 0), 제목 인풋(기본값 = 확장자 뗀 파일명),
  태그 인풋, ParticipantPicker 연동(선택 참석자 칩 표시), [업로드] btn-primary →
  api.createMeeting → api.uploadAudio(file, duration) → navigate(`/meetings/${id}`). 업로드 중 스피너/비활성화.
- 진입점: MeetingsPage 헤더에 [⬆ 파일 업로드] btn-ghost, RecordPage 녹음 시작 전 화면에 보조 버튼("또는 오디오 파일 업로드").

## GPU 자동 감지 STT (추가 기능)

`services/stt.py`가 디바이스를 자동 선택한다 (config.WHISPER_DEVICE = auto|cpu|cuda):
- Windows에서 nvidia pip 패키지(nvidia-cublas-cu12/nvidia-cudnn-cu12)가 설치돼 있으면
  해당 패키지의 DLL 디렉터리를 `os.add_dll_directory`로 등록(임포트 실패는 조용히 무시).
- auto: `ctranslate2.get_cuda_device_count() > 0`이면 cuda(float16), 아니면 cpu(int8).
  cuda 모델 로드/워밍업 예외 시 한국어 경고 로그 후 cpu(int8) 재시도(폴백 상태 기억).
- compute_type: config.WHISPER_COMPUTE가 비어 있으면 cuda→float16, cpu→int8.
- `get_device_info() -> str` 노출: 아직 로드 전이면 "cuda(예정)"/"cpu(예정)" 형태, 로드 후엔 실제 사용 중인
  "cuda:float16" | "cpu:int8" 형태. main.py의 /api/health가 whisper_device로 노출(이미 반영됨).

## 태그(프로젝트) · 소속/직책 관리 + 설정 페이지 (추가 기능)

### tags API (`routers/org.py`, prefix `/api`, 인증 필요)
- `GET /api/tags` → `[{id, name, color}]` (name ASC)
- `POST /api/tags` `{name, color?}` → Tag (name trim, 중복 시 400 "이미 있는 태그예요", color 미지정 시 팔레트 순환)
- `PATCH /api/tags/{id}` `{name?, color?}` → Tag — **name 변경 시 해당 태그명을 쓰는 내 meetings.tag도 함께 UPDATE**
- `DELETE /api/tags/{id}` → `{ok}` — 회의의 tag 문자열은 남겨둠(태그 사전에서만 제거)
- 태그 팔레트(순환): `["#16a34a", "#2563eb", "#e8590c", "#7048e8", "#d6336c", "#0ca678", "#f08c00", "#1098ad"]`

### org-options API (같은 `routers/org.py`)
- `GET /api/org-options?kind=department|role` → `[{id, kind, name}]` (kind 생략 시 전체, kind→name ASC)
- `POST /api/org-options` `{kind, name}` → OrgOption (중복 400 "이미 등록돼 있어요")
- `DELETE /api/org-options/{id}` → `{ok}`

### participants 확장
- participants 테이블에 `department TEXT` 컬럼 추가됨(db._migrate). 모든 응답에 `department` 포함,
  POST/PATCH에서 department 수용(빈 문자열 → NULL). 프론트 Participant 타입에도 반영됨.

### meetings 확장
- `GET /api/meetings?tag=<태그명>` 필터 지원(q와 조합 AND).

### 프론트 — 설정 페이지 (`pages/SettingsPage.tsx`, 라우트 `/settings` 반영됨)
좌측 섹션 네비(스크롤 또는 탭) + 우측 콘텐츠, 섹션 4개:
1. **AI 요약 엔진** — 기존 SettingsModal의 내용을 `components/AiEngineSettings.tsx`(모달 아님, 카드 섹션)로
   리팩터링해 재사용. SettingsModal.tsx는 삭제하고 Sidebar의 ⚙️ 설정 메뉴는 navigate('/settings')로 변경.
2. **태그 · 프로젝트** — 태그 CRUD: 추가 폼(이름 + 색 팔레트 선택), 목록(색 점 + 이름 + 이름 인라인 수정 + 삭제 confirm).
   설명 문구: 회의를 프로젝트/과제별로 분류합니다 (예: Consurt, Panicare, AX Sprint).
3. **소속 · 직책** — 2컬럼: 소속/부서 목록 CRUD, 직책 목록 CRUD (추가 인풋 + Enter/버튼, 항목 hover 삭제 ×).
4. **참석자** — 참석자 디렉터리 테이블(Avatar, 이름, 소속, 직책, 삭제/수정). 수정은 인라인 또는 작은 팝업,
   소속/직책 입력은 org-options 기반 콤보박스(TagPicker와 유사한 자유입력+선택).

### 프론트 — TagPicker (`components/TagPicker.tsx`)
`{value: string | null; onChange: (tag: string | null) => void; compact?: boolean}` —
버튼(현재 태그 칩 또는 "+ 태그") 클릭 시 드롭다운 팝오버: 등록된 태그 목록(색 점, 클릭 선택), "태그 없음" 옵션,
하단 "새 태그 만들기" 인라인 입력(입력 시 api.createTag 후 선택). 외부 클릭으로 닫힘.
사용처: RecordPage(기존 태그 인풋 대체), UploadModal(태그 인풋 대체), MeetingDetailPage(태그 칩 클릭 → 변경).
태그 색은 listTags에서 이름 매칭으로 조회해 칩에 반영(모르는 태그명은 기본 초록).

### 프론트 — MeetingsPage 태그 필터/폴더 뷰
- 검색줄 아래 태그 필터 칩 행: [전체] + 등록된 태그들(색 반영) + [태그 없음]. 선택 시 listMeetings(q, tag)
  ("태그 없음"은 클라이언트에서 tag가 null/빈 회의만 필터).
- 보기 토글(우측): 목록 보기 ↔ 폴더(그룹) 보기. 폴더 보기는 태그별 접을 수 있는 그룹(📁 태그명 + 개수,
  클릭 시 접기/펼치기, 태그 없는 회의는 "미분류" 그룹 맨 아래).

### 프론트 — ParticipantPicker 업그레이드
- 상단 검색 인풋(이름/소속/직책 부분일치로 칩 필터링).
- 새 참석자 추가 폼: 이름 + 소속 콤보박스 + 직책 콤보박스(org-options 목록에서 선택하거나 자유 입력,
  자유 입력 시 org-options에도 자동 등록).
- 칩에 title 속성으로 "소속 · 직책" 툴팁.

## 디자인 규칙
- global.css의 CSS 변수/클래스만 색상 소스로 사용. 배경 `--bg`, 카드 흰색 radius 12~16px + `--shadow-card`.
- 버튼: `.btn .btn-primary|.btn-ghost|.btn-danger|.btn-soft`. 인풋: `.input`. 배지: `.badge .badge-*`. 칩: `.chip`.
- 폰트는 index.html에서 Pretendard 로드됨. 아이콘은 이모지/인라인 SVG만 (외부 아이콘 패키지 금지).
- 반응형은 데스크톱 우선(min-width 1024px 기준), 과도한 미디어쿼리 불필요.
