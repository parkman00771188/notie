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

## 2차 개선 (요약 프롬프트 · 설정 탭 · 참석자 조직 관리 · 마크 · 레코더 UI)

### A. 사용자 지정 요약 프롬프트
- app_settings key `summary_prompt` (빈 문자열 = 삭제 = 기본 프롬프트만 사용).
- settings API: GET/PUT 응답에 `summary_prompt: str` 포함(없으면 ""). PUT 바디에 `summary_prompt?` 수용(trim, 빈 값 삭제) — gemini_api_key와 같은 upsert 패턴.
- summarizer: `get_summary_prompt()` 헬퍼(app_settings 조회). Gemini/Ollama 프롬프트에 사용자 지시사항 섹션으로 삽입:
  "다음은 사용자가 지정한 추가 지시사항이다. 기본 규칙과 충돌하면 사용자 지시를 우선하라:\n<prompt>".
- LLM 프롬프트에 **메모/마크 목록을 명시적으로 포함**: 각 북마크를 "[HH:MM:SS] (마크|메모) 제목" 줄로 나열하고,
  "사용자가 회의 중 남긴 메모는 중요 포인트이니 요약과 회의록에 반드시 반영하라"는 지시 추가.
- AiEngineSettings UI: "요약 지시사항 (프롬프트)" textarea(placeholder 예: "결정 사항은 담당자와 기한을 반드시 표기해줘.
  회의록은 격식체로 작성해줘.") + 저장 버튼("저장됨 ✓" 패턴 재사용), 아래 muted 설명.

### B. 설정 페이지 탭 방식 전환
- SettingsPage: 스크롤 앵커 방식 제거 → 좌측 메뉴 클릭 시 **해당 섹션만** 우측에 렌더(useState 탭).
  URL 해시(#ai/#tags/#org/#people) 동기화(선택), 기본 첫 탭. IntersectionObserver/scrollIntoView 코드 삭제.

### C. 참석자 조직(소속)별 관리 + 연락처
- participants 컬럼 추가됨(뼈대 반영 완료): organization(소속 회사/기관), email, phone. department는 부서.
- participants API: POST/PATCH에서 organization/email/phone 수용(빈 문자열→NULL), 모든 응답에 포함.
  meetings의 serialize_meeting 참석자에도 포함.
- org_options kind에 'organization' 추가됨(뼈대 반영 완료). org.py의 kind 검증을 3종으로 확장.
- SettingsPage 참석자 섹션: **소속별 그룹**(접기/펼치기 카드: "🏢 마인즈에이아이 (3명)", 소속 없음은 "소속 미지정" 마지막).
  행: Avatar, 이름, 부서, 직책, 이메일, 전화 + 수정(인라인)/삭제. 추가 폼: 이름* + 소속/부서/직책 콤보박스(datalist,
  자유 입력 시 org-options 자동 등록) + 이메일/전화 인풋.

### D. ParticipantPicker 재설계 (검색 중심)
- 기존 "전체 칩 나열" 제거 → **검색 인풋 + 아래 제안 드롭다운**:
  입력하면 이름/소속/부서/직책 부분일치 참석자가 텍스트박스 바로 아래 리스트로 표시(Avatar, 이름, "소속 · 부서 · 직책" 서브텍스트),
  클릭 또는 ↑↓+Enter로 추가. 인풋 포커스 시 미선택 참석자 전체(최대 8명)를 제안으로 표시.
- 선택된 참석자는 인풋 위에 색 칩으로 표시, × 로 제거. **기본 선택은 항상 없음.**
- 드롭다운 마지막에 "+ '<검색어>' 새 참석자로 추가" 항목 → 인라인 폼(이름 프리필 + 소속/부서/직책 콤보박스 + 이메일/전화)으로 전환.
- props {open,onClose,selected,onChange} 유지.

### E. 재요약 = 메모 + 전체 스크립트 기반
- MeetingDetailPage의 재생성 버튼 문구를 "🔄 재요약"으로, 옆에 muted 설명 "메모와 전체 스크립트를 기준으로 다시 요약합니다".
- 백엔드는 A에서 북마크를 프롬프트에 포함하므로 enqueue_summary 경로 그대로 사용(이미 bookmarks 전달됨 — 확인/보강).

### F. 마크(북마크 kind) + 레코더 UI 리디자인
- bookmarks.kind 컬럼 추가됨('memo'|'mark', 기본 'memo', 뼈대 반영 완료). bookmarks API POST/PATCH kind 수용, 응답 포함.
- RecordPage "마크 추가" → kind='mark'로 생성(제목 "마크 N"). 메모 인풋 → kind='memo'.
- 메모 리스트(녹음 중/상세 페이지 모두)에서 kind='mark' 항목은 **라벨 배지**(🔖 "마크", badge-blue 계열)로 구분,
  memo는 배지 없음(또는 회색 "메모").
- **MeetingDetailPage 오디오 플레이어 옆 "🔖 마크 추가" 버튼**: 현재 재생 시간(audio.currentTime)에 kind='mark' 북마크 생성
  → 목록 즉시 갱신. (audio가 없으면 버튼 숨김)
- **레코더 카드 리디자인** (첨부 스크린샷 기준):
  - 큰 타이머(00:00:08)를 카드 상단 **중앙 정렬**, 그 아래 **전폭 연파랑(#eef4ff 계열, radius-lg) 파형 패널**.
  - 파형은 패널 세로 중앙의 가는 수평선 위에 **파란 점(dot) 시퀀스**로 진행 — 250ms마다 진폭 샘플이 왼쪽부터 점으로 쌓이는 스타일
    (진폭이 크면 점이 세로로 살짝 확장/진해짐; Waveform.tsx 재작성, 북마크 핀 표시는 유지).
  - 컨트롤 버튼 3개를 파형 아래 **중앙 정렬**: [⏸ 일시정지 btn-ghost] [■ 종료 btn(빨강 배경 흰 글씨)] [🔖 마크 추가 btn-soft].
  - 기존 상단 좌측 "🔴 녹음 중" 표시는 타이머 위 중앙의 작은 배지로 이동.

### H. Gemini 장문 스크립트 파일 첨부 + 메모 필터
- summarizer의 LLM 프롬프트 메모 목록에는 **kind='memo'만 포함** (kind='mark'는 시간 핀일 뿐이므로 제외).
- Gemini 호출 시 전체 스크립트 텍스트가 임계값(env `GIMNOTE_GEMINI_ATTACH_THRESHOLD`, 기본 20000자) 초과이면:
  스크립트를 프롬프트 텍스트에 인라인하지 않고 **별도 파트로 첨부** —
  `contents[0].parts = [{text: 지시문+메모목록+"전체 스크립트는 첨부된 텍스트 파일(transcript.txt)을 참고하라"}, {inline_data: {mime_type: "text/plain", data: base64(스크립트)}}]`.
  임계값 이하면 기존 인라인 방식 유지. Ollama는 인라인 유지(로컬이라 무관).

### I. 시간 기록 없는 일반 메모(note) — 3차
- BookmarkKind에 'note' 추가(시간 기록 없는 사용자 메모, time_sec은 0으로 저장·표시 안 함).
- bookmarks 라우터 kind Literal에 'note' 포함.
- RecordPage: 메모 입력을 **textarea(2~3줄, 자동 높이)**로 확대. Enter 제출/Shift+Enter 줄바꿈.
  입력창 옆(또는 아래) "⏱ 시간 기록" 체크박스(기본 ON) — 해제 시 kind='note'로 저장.
  메모 리스트에서 note는 시간 칩 없이 📝 "메모" 배지(badge-gray)로 표시, 별도 "일반 메모" 그룹으로 시간 메모 아래 묶어 표시. 수정/삭제 동일 지원.
- MeetingDetailPage 메모 탭: note 항목은 시간 칩 없이 📝 배지로 별도 "일반 메모" 그룹 표시(클릭 점프 없음),
  탭 하단에 일반 메모 추가 textarea + 버튼(kind='note') — 회의가 끝난 뒤에도 메모 보완 가능. 수정/삭제 지원.
- summarizer LLM 프롬프트: kind='memo'는 "[HH:MM:SS] 제목", kind='note'는 "(일반 메모) 제목"으로 포함, kind='mark' 제외 (H와 함께).

### G. 태그 색상 자유 선택
- SettingsPage 태그 섹션 + TagPicker "새 태그 만들기": 8색 팔레트 스와치 **+ 커스텀 색 선택기(`<input type="color">`)**
  (팔레트 옆 🎨 무지개 스와치 → 클릭 시 컬러 피커, 선택한 색이 스와치에 반영·선택됨). 태그 인라인 수정에서도 색 변경 가능(스와치+피커).

## 4차 개선 (J) — 메모창 확대 · 전체 보기 팝업 리디자인 · 오디오 플레이어 · 콤보박스

### J1. RecordPage 메모 입력창 확대
- textarea 기본 3줄, min-height 약 88px, 자동 확장 최대 8줄. 폰트 15px. 나머지 동작(Enter 제출 등) 불변.

### J2. AudioPlayerCard (레코더 스타일 재생 UI + 파형 클릭 이동)
`components/AudioPlayerCard.tsx` + css 신규. `forwardRef` + `useImperativeHandle`:
```ts
export interface AudioPlayerCardHandle { seekTo(sec: number, autoplay?: boolean): void }
props: {
  src: string
  durationSec?: number | null        // webm duration Infinity 대비 폴백
  bookmarks: { id: number; time_sec: number; title: string; kind: BookmarkKind }[]  // note 제외돼 전달됨
  onAddMark?: (timeSec: number) => void  // 없으면 마크 버튼 숨김
}
```
- 내부에 숨긴 `<audio>` 엘리먼트로 실제 재생. 레이아웃(레코더 카드와 동일 무드):
  중앙 큰 타이머 `현재시간` (아래 작게 `/ 총시간`), 전폭 연파랑(--primary-soft) radius-lg **파형 패널**,
  아래 중앙 버튼: [▶ 재생|⏸ 일시정지 btn-primary] [🔖 마크 추가 btn-soft].
- 파형: fetch(src) → AudioContext.decodeAudioData → 채널 데이터를 ~600 버킷 피크 배열로 다운샘플 → canvas에
  세로 중앙 수평선 + 점(dot)/캡슐 시퀀스(진폭 비례 높이). **재생된 구간은 진한 파랑, 이후는 연한 파랑**, 현재 위치 세로 커서.
  디코드 실패 시 균일 점 + 진행 표시로 폴백(재생은 정상).
- **클릭/드래그로 시크**(클릭 x → 시간 비례 이동). 북마크 핀(🔖/시간 칩)을 파형 위에 표시, 클릭 시 해당 시간으로 시크.
- ref.seekTo는 스크립트 세그먼트/메모 시간 칩 클릭에서 사용(기존 점프+재생 동작 유지).

### J3. MeetingDetailView 분리 + 최근 회의 전체 보기 팝업 리디자인 (스크린샷 1·2 재현)
- `components/MeetingDetailView.tsx` 신규 — 기존 MeetingDetailPage의 **본문 전체**(헤더/메타/참석자/AudioPlayerCard/탭/폴링/편집/재요약/삭제)를
  이 컴포넌트로 이동. props `{meetingId: number; onBack?: () => void; onDeleted?: () => void; onChanged?: () => void}`.
  onBack이 있으면 상단에 "← 회의 목록" 버튼. 삭제 성공 시 onDeleted(없으면 navigate('/meetings')).
  MeetingDetailPage는 useParams로 meetingId만 얻는 얇은 래퍼로 축소(레이아웃/여백 유지). CSS는 MeetingDetailView.css로 이동.
- RecentMeetingsPanel의 "전체 보기" Modal 리디자인(width ~960, 최대 높이 82vh, 내부 스크롤):
  - 헤더 아래 **태그 필터 칩 행**([전체] + 색 점 포함 태그 칩) + 우측 [☰ 목록 보기 ↔ 📁 폴더 보기] 토글(기본 폴더).
  - 폴더 보기: 태그별 접이식 그룹(▾ 📁 색점 태그명 + 개수 배지), 행 = 제목 + `#태그명`(태그색 텍스트) + StatusBadge + 날짜(formatRelativeDate) + 시간(formatClock). 태그 없음 그룹 마지막("태그 없음", 회색).
  - 행 클릭 → **팝업 안에서** MeetingDetailView 렌더(리스트 대체, onBack으로 리스트 복귀). navigate 아님.
  - 푸터: 좌측 muted "💡 회의를 클릭하면 상세 내용을 확인할 수 있어요." / 우측 "전체 회의 보기 →" 링크(→ /meetings, 모달 닫기).
- MeetingsPage의 행 클릭은 기존대로 페이지 이동 유지.

### J4. ComboBox 컴포넌트 + 설정 참석자 섹션 통합
- `components/ComboBox.tsx` + css 신규 — 예쁜 커스텀 드롭다운 콤보박스:
```ts
props: {
  value: string; onChange: (v: string) => void
  options: string[]                  // 정렬된 옵션 목록
  placeholder?: string
  onCreateOption?: (name: string) => void   // 새 값 등록 콜백(있으면 "+ 추가" 행 표시)
  onDeleteOption?: (name: string) => void   // 있으면 옵션 hover 시 × (confirm)
}
```
  - 인풋 + ▾ 버튼. 포커스/클릭 시 드롭다운: 옵션 리스트(부분일치 필터, ↑↓+Enter, hover 하이라이트),
    입력값이 목록에 없으면 최하단 `+ "<입력값>" 추가` 행(클릭/Enter 시 onCreateOption + 값 선택).
    외부 클릭/ESC 닫기. 자유 입력도 그대로 value로 유지(등록 없이 입력만 해도 됨).
  - 스타일: .input 기반, 드롭다운은 shadow-pop 카드, 선택/하이라이트 --primary-soft.
- SettingsPage: **"소속 · 직책" 섹션(탭) 제거** → 탭 3개(AI 요약 엔진/태그·프로젝트/참석자).
  참석자 추가 폼과 인라인 수정의 소속/부서/직책 입력을 datalist 대신 **ComboBox**로:
  options = org-options(kind별), onCreateOption = createOrgOption(중복 400 무시), onDeleteOption = deleteOrgOption(이름→id 매핑).
- ParticipantPicker의 새 참석자 폼도 datalist → ComboBox로 교체(onDeleteOption은 생략 가능).

### J5. Gemini 모델 선택 + 설정 탭 순서
- app_settings key `gemini_model` — 저장 시 config.GEMINI_MODEL 대신 사용(빈 값 삭제 = 기본값 복귀).
- settings API: GET/PUT의 `gemini_model`은 유효값(DB → config 순). PUT 바디에 `gemini_model?` 수용(trim, 빈 값 삭제).
- 신규 `GET /api/settings/gemini-models` → 저장된 키로 `GET {GEMINI_BASE_URL}/models?key=...&pageSize=50` 호출(timeout 10s),
  `supportedGenerationMethods`에 "generateContent" 포함 + name에 "gemini" 포함 모델만
  `{models: [{name: "gemini-2.0-flash", display_name}], error: null}` 반환(name은 "models/" 프리픽스 제거).
  키 없음/호출 실패 시 `{models: [], error: "<한국어 사유>"}` (200으로).
- summarizer: `get_gemini_model()` 헬퍼(app_settings → config.GEMINI_MODEL). `_try_gemini`/`test_gemini_key`가 이를 사용, engine 문자열에도 반영.
- 모델 목록은 백엔드에서 **최신순 정렬**(-latest 별칭 → 버전 내림차순 → 이름순)되어 내려오며,
  TTS/이미지/라이브 등 텍스트 요약에 부적합한 변형은 제외됨.
- AiEngineSettings UI: Gemini 카드에 "모델" 선택 UI — 키 등록 시 listGeminiModels로 불러온 목록의 드롭다운(ComboBox 재사용 가능, 순서 유지),
  실패/키 없음 시 수동 입력 + 추천 목록 폴백 ["gemini-flash-latest", "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-2.5-flash", "gemini-2.5-pro"].
  저장은 updateSettings({gemini_model}) — "저장됨 ✓" 패턴. 현재 유효 모델 표시.
- **설정 탭 순서: [태그 · 프로젝트] → [참석자] → [AI 요약 엔진]**, 기본(첫) 탭 = 태그 · 프로젝트.

## 5차 개선 (K) — 요약 구조 개편 · 휴지통 · 확인 팝업 · 실패 사유 표시

### K1. 요약 구조 개편 (회의내용/핵심내용/결정사항 + 추가 확인 필요)
- summaries에 discussion(TEXT, 마크다운), followups(TEXT, JSON 배열), engine_note(TEXT|NULL) 컬럼 추가됨(뼈대 완료).
  types.ts Summary에도 반영됨.
- **LLM JSON 스키마 변경**: `{discussion: "회의내용 — 주제별로 묶어 마크다운 소제목(###)/불릿으로 정리(시간순 나열 금지)",
  key_points: ["핵심내용 3~7개 — 요구사항/문제점/검토 필요/주요 의견"], decisions: ["명확하게 결정된 것만"],
  followups: ["추가 확인 필요 사항"], action_items: [{text, owner, due}]}`.
  프롬프트에 결정사항 규칙 명시: "명확한 결정이 없으면 decisions는 빈 배열로 두라(논의만 된 내용은 followups로)".
- summarize() 반환에 discussion(str), followups(list[str]), engine_note(str|None) 추가.
  **engine_note**: Gemini/Ollama 실패로 폴백했을 때 사유 요약(예: "Gemini 호출 실패(HTTP 404: 모델 없음) → 내장 요약으로 대체").
  정상이면 None. 실패 시 HTTP 상태/사유를 사람이 읽을 한국어로.
- 추출 폴백: discussion = 상위 점수 문장 5~8개를 불릿 마크다운으로, followups = `확인 필요|검토|추후|다시 논의|파악` 패턴 문장(최대 5).
- pipeline: summaries INSERT에 discussion/followups(json)/engine_note 저장. meetings 라우터의 상세 직렬화에 세 필드 포함
  (레거시 행은 discussion '' / followups '[]' / engine_note NULL).
- **minutes_md 구조 변경**:
  `# 제목` / `**일시** · **소요 시간**` / `## 참석자` (없으면 "_(기록된 참석자가 없습니다)_", 있으면 `- 이름 (소속 · 부서 · 직책 — 있는 것만)` 리스트)
  / `## 회의내용` (discussion 그대로) / `## 핵심내용` 불릿 / `## 결정사항` (`- [x]` 리스트, 비어 있으면 "명확히 확정된 결정사항은 없음")
  / followups 있으면 `### 추가 확인 필요 사항` `- [ ]` 리스트 / `## 액션 아이템` / `## 타임라인` / (일반 메모 있으면) `## 일반 메모`.
- MeetingDetailView AI 요약 탭 구조 변경: **[회의내용]**(marked 렌더) → **[핵심내용]** 불릿 → **[결정사항]**(✅ 리스트,
  비면 muted "명확히 확정된 결정사항은 없음") → **[추가 확인 필요 사항]**(❓ 리스트, 있을 때만) → **[할 일]**(체크박스) → 엔진 표기.
- engine_note가 있으면 요약 탭 상단에 경고 배너(노란 톤 카드): "⚠ {engine_note}" + "설정 확인" 링크(/settings#ai).

### K2. 휴지통 (소프트 삭제)
- meetings.deleted_at 컬럼 추가됨(뼈대 완료). api.ts에 listTrash/restoreMeeting/purgeMeeting 추가됨.
- meetings 라우터:
  - `DELETE /{meeting_id}` → 소프트 삭제(deleted_at=now, 오디오 파일 유지) → {ok}
  - `GET /trash` → 삭제된 회의 목록(deleted_at DESC, Meeting 형태 + deleted_at 필드 포함) — **경로 순서 주의: /trash를 /{meeting_id}보다 먼저 선언**
  - `POST /{meeting_id}/restore` → deleted_at=NULL → Meeting
  - `DELETE /{meeting_id}/permanent` → 실제 삭제(오디오 파일 포함) → {ok}
  - 기존 모든 조회(GET 목록/상세/status/audio/북마크 소유 검증 등)는 `deleted_at IS NULL` 조건 추가.
    get_owned_meeting에 include_deleted 파라미터(restore/permanent만 True).
- MeetingsPage 헤더에 [🗑 휴지통] btn-ghost → `components/TrashModal.tsx` + css:
  Modal(width 640): 목록(제목, 태그, 삭제일 formatRelativeDate, 원래 날짜/길이), 행 우측 [복원 btn-soft] [완전 삭제 btn-danger(확인 팝업)],
  빈 상태("휴지통이 비어 있어요"), 복원/삭제 시 목록 갱신 + 부모 새로고침 콜백. 하단 muted "완전 삭제한 회의는 복구할 수 없어요."

### K3. 확인 팝업 (window.confirm 대체)
- `components/confirm.tsx` + confirm.css 신규: `ConfirmProvider`(Layout에서 children 감싸기) + `useConfirm()` 훅.
  `const confirm = useConfirm(); const ok = await confirm({title, message?, confirmLabel?, cancelLabel?, danger?})` — Promise<boolean>.
  디자인: Modal과 같은 오버레이/카드(width 400), 제목 굵게, 메시지 muted, 우측 하단 [취소 btn-ghost] [확인 btn-primary|btn-danger].
  ESC/오버레이 클릭 = 취소. danger면 확인 버튼 빨강.
- 기존 window.confirm 호출 전부 교체: MeetingsPage(회의 삭제→"휴지통으로 이동할까요?" 문구로), MeetingDetailView(삭제/북마크 삭제),
  SettingsPage(태그/참석자 삭제), ComboBox(옵션 삭제), RecordPage(메모 삭제 등 있으면), RecentMeetingsPanel/TrashModal.
  (window.prompt 기반 편집은 이번 범위 아님 — 그대로 둠)

## 디자인 규칙
- global.css의 CSS 변수/클래스만 색상 소스로 사용. 배경 `--bg`, 카드 흰색 radius 12~16px + `--shadow-card`.
- 버튼: `.btn .btn-primary|.btn-ghost|.btn-danger|.btn-soft`. 인풋: `.input`. 배지: `.badge .badge-*`. 칩: `.chip`.
- 폰트는 index.html에서 Pretendard 로드됨. 아이콘은 이모지/인라인 SVG만 (외부 아이콘 패키지 금지).
- 반응형은 데스크톱 우선(min-width 1024px 기준), 과도한 미디어쿼리 불필요.
