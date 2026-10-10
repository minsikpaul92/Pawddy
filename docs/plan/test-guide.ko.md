# Goldito 기능 현황 · 테스트 가이드

> **누구를 위한 문서?** 개발에 같이 참여하는 사람(민식 · 슬기 · 묵)과 테스트하는 사람.
> **무엇을 알 수 있나?** ① 지금 무엇이 만들어졌고 무엇이 아직인지 ② 어떻게 확인하는지 ③ 확인 결과.
> **언제 갱신하나?** 작업(Task) 하나가 끝날 때마다 **같은 커밋에서** 현황표와 시나리오를 고친다 ([CLAUDE.md](../../CLAUDE.md) §5).
> 제품 흐름은 [full-process.ko.md](full-process.ko.md), 할 일 큐는 [TODO.md](TODO.md).

**마지막 갱신:** 2026-10-09 · #60 머지(FLOW-13~23 · REPORT-11~12 · RV-6~10 수정) · 테스트는 **main = Vercel** (§1.1) · 슬기 QA 트랙 [Phase Q](phases/phase-q.md) · 이전: 첫 수동 테스트 결과 (§3.0), 코드 리뷰 시나리오 (§3.17)

---

## 1. 시작하기

### 1.1 접속 — 테스트는 항상 main을 Vercel에서 (2026-10-09 결정)

| 환경 | 주소 | 비고 |
| :--- | :--- | :--- |
| **Production (main) — 손 테스트는 여기** | **https://goldito-petcare.vercel.app** | main이 머지될 때마다 자동 배포. 결과(✅)는 여기서 한 것만 기록 |
| Vercel preview (선택) | PR 코멘트의 Preview 링크 | 머지 전 미리 보기용 — 결과 기록은 main 기준 |
| 로컬 (개발할 때만) | `http://localhost:8081` + 백엔드 `http://localhost:8000` | `cd frontend && npx expo start --web --port 8081`, `cd backend && .venv/bin/uvicorn app.main:app --port 8000` |

> **백엔드 (U0, 2026-10-09):** Vercel 빌드는 Render의 **https://goldito-backend.onrender.com** 을 본다 → 업로드 · AI · 데모 리셋(Profile → Demo tools)이 Vercel에서 된다. 무료 플랜이라 **15분 동안 요청이 없으면 잠들고 첫 요청이 30~50초** 걸린다(keep-alive cron이 깨워 둠). PR **Preview는 CORS에 없어** 업로드 · AI가 안 된다 — 결과는 main(Production)에서.
> 어느 환경이든 **호스티드 Supabase(실제 DB)** 에 붙는다. 테스트가 실제 데이터를 만든다는 뜻이다 (1.4 참고).

### 1.2 데모 계정

로그인 화면의 **Try the demo** → **Demo owner** / **Demo sitter** 버튼 (비밀번호 입력 불필요).

| 계정 | 이름 | 가진 것 |
| :--- | :--- | :--- |
| `demo-owner@goldito.test` | Robert (오너) | 강아지 **Max**, 고양이 **Mochi** |
| `demo-sitter@goldito.test` | Chloe (시터) | Robert의 확정 예약 1건 (아래) |

> **데모 이메일:** 호스팅 DB 계정은 `@goldito.test`(이름 Robert / Chloe). 호스팅 DB에 옛 `seed_demo.py`(`@pawddy.test`)를 돌리지 말 것.

### 1.3 데모 데이터 (2026-10-04 기준 — 2026-10-08 현재 아래 참고)

- Robert ↔ Chloe 예약 **확정**, 미팅 완료, **결제 전**. Max · Mochi.
- 드롭오프 완료(10/4), **픽업 예정 10/7 05:37 UTC (토론토 10/7 새벽 1:37)**.
- 그래서 **지금 Chloe는 "돌보는 중"** 이다 → 시터 Home의 할 일 · 체크인이 보인다.
- ⚠️ **픽업 시각이 지나면** 시터 쪽 시나리오(TASK · CHK)가 "Tasks open once the stay has started" 등으로 막힌다. 그때는 새 예약을 만들어 드롭오프를 완료 처리하거나 시드 스크립트(Phase 10, 10.1)를 쓴다.
- **상태는 누가 마지막에 무엇을 했는지에 따라 다르다.** 원하는 시작 상태(`empty` · `pets` · `confirmed` · `ready` · `in_care`)로 리셋하는 법은 [test-run.ko.md](test-run.ko.md) §1 (`backend/scripts/reset_demo.py`, dry run 먼저 — 민식 PC에서; 백엔드 배포 뒤에는 앱의 Profile → Demo tools).

### 1.4 테스트가 남기는 데이터

| 지울 수 있음 (앱에서) | 지울 수 없음 (의도된 규칙) |
| :--- | :--- |
| 돌봄 할 일 (Delete), 피드 사진 (🗑️) | 체크인, 완료 기록, 알림 — 클라이언트는 읽기 전용 |

→ 테스트 후 알림·체크인이 쌓인다. 필요하면 `reset_demo.py` / Demo tools로 리셋한다. 심사용으로는 Phase 10에서 고정 데모 계정으로 바꾼다.

---

## 2. 기능 현황

범례: ✅ 만들어짐 · 🟡 일부 · ⬜ 아직 · 🤖 자동 테스트 있음 · 👤 사람이 확인해야 함

### Stage 1 — Inquiry (문의)

| 기능 | 상태 | Phase |
| :--- | :--- | :--- |
| 오너 **문의 보내기** (시터 프로필 → Ask before booking: 서비스 · 반려동물 · 날짜 · 장소 · 질문(선택) → 대화 화면, 시터가 보낸 답만 보임, 견적 카드 · 출처 칩, Request booking 자동 입력, 불가 날짜면 **Change dates**(날짜 · 펫이 채워진 새 문의) + Find other sitters(보조), 시터 답장 뒤 오너가 **Write back**으로 이어 쓰기 → 새 AI 초안, 시터 목록은 **마지막 오너 메시지** 기준으로 "답함" 판정 — FB-34) | ✅ 🤖 `inquiry.spec.ts` (실제 두 계정 · 실제 DB는 👤 — 호스팅 DB에 010 적용됨 2026-10-07) | 07B / 7B.5 |
| 시터 **문의함** (Questions 탭 · 초안 Send 한 번 / Edit·Add / Regenerate / 의도 칩 · 경고 문구 · 열면 읽음) + 정책 편집 | ✅ 🤖 `inquiry.spec.ts` | 07B / 7B.6 |
| 문의 답장 **초안 API** (일정 · 견적 · 반려동물 · RAG 근거 → Nano, 금액 · 날짜 · 1인칭 · 출입 정보 검사, 정책 체중 한도, 멱등, 오너에게는 초안을 안 줌) | ✅ 🤖 pytest a–k (실제 모델 확인 · 지연 p50 3.2 s) | 07B / 7B.3–7B.4 · 7B.7 |
| RAG (문단 청크 · 재색인 · 범위 제한 검색) | ✅ 🤖 pytest + SQL smoke M | 07B / 7B.2 |
| **시터 말투** (스타일 카드 + 본인 예시 · 익명화 · 그대로 / 수정 / 다시 생성 학습) | ✅ 🤖 pytest · 실제 모델로 두 시터 다른 말투 확인 · 블라인드 평가(약 50건)는 👤 | 07B / 7B.8–7B.9 |
| **자동 발송** (동의 모달 · 약 30초 사람 속도 · typing → 말풍선 · 시터가 열기 전엔 읽음 없음) | ✅ 🤖 pytest + `inquiry.spec.ts` + SQL smoke M (지연 공식은 슬기 확정 전 기본값) | 07B / 7B.10 |
| 문의 에이전트 (tool calling, `INQUIRY_AGENT=off\|auto\|on`, **기본 `auto`** = 게이트가 필요하다고 볼 때 Nemotron Super로 — 지금은 거의 항상 켜짐, 리뷰 M-1) | ✅ 🤖 pytest · 실제 모델 확인 | 07B / 7B.11 |

### Stage 2 — Meet & Greet · 케어 요청

| 기능 | 상태 | Phase |
| :--- | :--- | :--- |
| 첫 만남 미팅 (직접 / 영상, 제안 · 수락 · 건너뛰기) | ✅ 🤖 | 03B.9 |
| Google Meet 링크 자동 생성 | 🟡 서버 완료, **앱 e2e 미확인** | 03B.11 |
| 오너가 돌봄 할 일 등록 (약 · 식사 · 산책 …) | ✅ 🤖 | 06 / 6.1 |
| AI 케어 요청서 → 체크리스트 (칩 · 한 줄씩 · 표 · 자동 저장) | ✅ 🤖 (실제 AI 응답은 👤) | 06 / 6.12–6.13 · 6.20 |

### Stage 3 — Booking (예약)

| 기능 | 상태 | Phase |
| :--- | :--- | :--- |
| 시터 스케줄 열기 / 막기 | ✅ 🤖 | 03B.1 |
| 내 시터 목록 · 시터 프로필 | ✅ 🤖 | 03B.2 |
| 예약 요청 (펫 · 시간 · 장소 · 서비스) | ✅ 🤖 | 03B.3 · 03B.10 |
| 시터 요청 함 (수락 · 시간 제안 · 거절) | ✅ 🤖 | 03B.4 |
| 협상 · 확정 후 변경 | ✅ 🤖 | 03B.5 |
| 도착 / 인계 체크 (Received · Returned) | ✅ 🤖 | 03B.6 |
| 취소 · 새 시터 찾기 | ✅ 🤖 | 03B.7 |
| 시터 Home 대시보드 | ✅ 🤖 | 03B.8 |
| 견적 · 동의서 · 데모 결제 · 시간 제한 출입 정보 | ✅ 🤖 | 03C |

### Stage 4 — 돌봄 · 알림장

| 기능 | 상태 | Phase |
| :--- | :--- | :--- |
| 사진 · 영상 업로드 (서명, 리사이즈, 30초 트림) | ✅ 🤖 (실제 Cloudinary는 👤) | 04 |
| 사진 선택 · **촬영** · 미리보기 → 확인 | ✅ 🤖 (실제 카메라는 👤) | 04 / 6.3 |
| 오너 **Feed** 앨범 · 전체화면 보기 (스와이프 · 화살표) | ✅ 🤖 | 05 |
| 시터 Feed (+ Photo) | ✅ 🤖 | 05 |
| **공개 범위** (시터 "Share with owner", 오너 "Visible to sitter") | ✅ 🤖 SQL · e2e | 05 / 5.8–5.9 |
| 작성자 삭제 🗑️ (파일까지 삭제) | ✅ 🤖 | 05 / 5.7 |
| 알림 (토스트 · 벨 · 알림센터 · 탭 이동) | ✅ 🤖 (실시간은 👤) | 05 |
| 알림 **밀어서 삭제**(60% 이상) · **Clear all** | ✅ 🤖 | 06 후속 |
| 실패하면 **닫을 때까지 남는 에러 팝업** + Try again | ✅ 🤖 | 06 후속 |
| **Heads-up** (오너가 관리 · 시터 Home 한 줄 · 예약 상세) | ✅ 🤖 | 06 / 6.14 |
| 오너 **케어 체크리스트 / 요청** (칩 → 줄 → 표, 돌보는 중엔 시터 승인 · 거절) | ✅ 🤖 (실제 AI · 두 계정은 👤) | 06 / 6.12–6.13 · 6.20 |
| 오너 **돌봄 할 일** 등록 · **시간 탭 선택** · 탭해서 **수정**(종류 고정) · 일시중지 · 삭제 | ✅ 🤖 | 06 / 6.1 + 후속 |
| 시터 **오늘 할 일** — Done → 팝업(메모 + 사진) → Done, 끝낸 건 목록에서 사라짐 | ✅ 🤖 | 06 / 6.2–6.4 · 6.3 + 후속 |
| 시터 **빠른 체크인** (식사 · 배변 · 산책 · 기분 · 메모 · 사진), 보냄 표시 · 연타 잠금 · 오늘 보낸 것 목록 | ✅ 🤖 | 06 / 6.8–6.10 + 후속 |
| 시터 **Home 대시보드** (한 화면) · 할 일 / 체크인 / 내 기록 화면 | ✅ 🤖 | 06 후속 |
| 오너 **Home 실시간 업데이트 카드** (밀어서 지우기) | ✅ 🤖 | 06 후속 |
| 오너 **History** (오늘 + 최근 7일 기록, 알림을 지워도 남음) | ✅ 🤖 | 06 / 6.11 |
| 오너 **Diary 탭** = 시터가 보낸 알림장 목록(첫 문장) → 항목 화면(본문 · 그날 사진 · 할 일), 초안은 안 보임, 알림 탭하면 해당 항목 | ✅ 🤖 `report.spec.ts` (실제 두 계정은 👤) | 07 / 7.3 |
| 시터 **리마인더 배너** (할 일 시간이 되면 Home 맨 위 배너 + 토스트) | ✅ 🤖 | 06 / 6.6 |
| 시터 **Diary** (펫이 둘 이상이면 먼저 펫 선택 · 오늘 요약 한 줄 · 칩 켜기/끄기 · 기록 값 고치기 · "Anything to add?" 짧은 줄 = 내 칩(× 지우기) · 사진 ≤ 2 → 초안 미리보기 수정 → Send, 새로고침 후 초안 유지, 탭으로 돌아오면 새 기록 칩) | ✅ 🤖 `report.spec.ts` (AI는 mock · 실제 모델 연결은 👤) | 07 / 7.3 |
| AI 알림장 **초안 API** (`POST /api/ai/daily-report`: 하루 기록 → 시터 1인칭 초안, 같은 날 덮어쓰기, 보낸 뒤엔 409, 기록이 없으면 고정 문장) | ✅ 🤖 pytest (실제 모델로 환각 점검 3회) · 화면은 시터 Diary(7.3) | 07 / 7.2 |
| **알림장 보내기** (`send_daily_report`: 시터가 고친 **최종 본문**만 게시, 오너는 보낸 것만 보임, 한 번만, 오너 알림) | ✅ SQL `rls_smoke` · 🤖 `report.spec.ts` (Send) | 07 / 7.5 |
| AI 알림장 **칩 제안 API** (`POST /api/ai/report-chips`: 하루 기록 → 칩(모델 없음), 사진 ≤ 2 → 한 줄 묘사 + 에피소드 칩, 느리거나 실패한 사진은 빼고 기록 칩은 유지, 남의 사진 403) | ✅ 🤖 pytest · 실제 비전 모델로 데모 사진 3장 확인(2026-10-07) · 화면은 시터 Diary(7.3) | 07 / 7.7 |
| **사진 자동 캡션 · 앨범 분류** (시터는 올리기만 → AI가 캡션 + 분류 → 피드 게시, "Writing a caption…" 단계, 실패해도 게시, 오너 Feed **Timeline / Album**) | ✅ 🤖 `caption.spec.ts` + pytest (실제 비전 모델로 샘플 9장 중 8장 분류 · 지연 약 1.2초 · 실제 사진 5장 합의는 👤) | 09 / 9.1–9.3 · 9.5 |
| Pet Transit (실시간 위치 · 도착) | ⬜ | 06B |

### Stage 5 — Completion · 기타

| 기능 | 상태 | Phase |
| :--- | :--- | :--- |
| **귀가 알림** (Returned → "Max and Mochi are home safe 🏠" → 바로 뒤 리뷰 요청 알림) · **Stay summary** (기간 · 알림장 수 · 사진 수 · 완료 할 일 수 · 마지막 알림장 첫 문장) | ✅ 🤖 `completion.spec.ts` + SQL smoke N (실제 두 계정 👤) | 07C / 7C.1–7C.2 |
| **리뷰** (★1–5 + 코멘트 ≤ 500 · 한 번만 · 귀가 뒤에만 · 시터 알림 · 시터 프로필 평균 ★ · 후기 수 · 최근 코멘트 3개) | ✅ 🤖 `completion.spec.ts` + SQL smoke N | 07C / 7C.1 · 7C.3 |
| **Pet Life Record** — AI 정리(근거 없는 문장은 버림 · 출입 정보 없음) · 오너 펫 화면 `📖 Life Record` · 끝난 예약 화면(자동 작성 · Retry) | ✅ 🤖 pytest + `completion.spec.ts` (실제 모델 확인, 실제 두 계정 👤) | 07C / 7C.4–7C.5 |
| 다음 시터 요청 카드의 **From Max's Life Record** (접힘) · 문의 AI 근거 칩 · 케어 체크리스트 초안에 지난 Heads-up 자동 제안 | ✅ 🤖 `sitter-bookings.spec.ts` + pytest | 07C / 7C.6 |
| 간식 안전 스캐너 | ⬜ (스트레치) | 08 |
| 로그인 · 회원가입 · 역할별 화면 · Welcome 투어 | ✅ 🤖 | 01 · 03 · OB |
| 펫 · 프로필 | ✅ 🤖 | 03 |
| 데스크톱 폰 프레임 · 마우스=손가락 | ✅ 🤖 | 01 |

---

## 3. 시나리오

**열 설명** — 자동: 같은 시나리오를 자동 테스트가 확인하는지 (스펙 이름). **상태**: ✅ 통과 · ❌ 실패 · ➖ 미확인 (+ 날짜 · 확인한 사람). 아직 아무도 사람 손으로 확인하지 않은 줄은 **➖** 이다.

### 3.0 테스트 진행 현황 (2026-10-08, 첫 수동 테스트 후)

**범례** ✅ 사람이 확인해 통과 · 🟡 일부만(또는 Claude가 확인, 사람 확인 대기) · ❌ 사람이 확인해 실패 · ➖ 아직 안 해 봄. 아래는 이번 첫 테스트(런북 §2 단계 1~5까지)에서 **사람이 직접 본 것**만 반영한 표입니다.

| 영역 | 결과 | 비고 |
| :--- | :--- | :--- |
| 예약 요청 → 수락 → Confirmed (BOOK-1) | 🟡 | 진행은 됨. 실시간 갱신 ❌ (FLOW-1) |
| 시간 · 장소 변경 (BOOK-2) | ❌ | FLOW-7 · 8 · 9 |
| 체크아웃 · 결제 (BOOK-5) | ❌ → 다시 확인 필요 | 요금표 없음이 원인이었음 — **10/08 Chloe 요금 행을 임시로 넣어 풀림**(견적 $268.13 확인). 예약을 새로 만들거나 기존 예약의 Finish booking을 다시 눌러 보세요 (FLOW-3) |
| Received → Returned (BOOK-4) | ❌ | Returned 확인 단계 없음 (FLOW-6), 진행 중이 Upcoming에 (FLOW-5) |
| 날짜 · 시간 입력 통일 (FLOW-10) · 이름 옆 역할 표시 (FLOW-11) · 입력칸 힌트 (FLOW-12) | ❌ | 모양 · 통일 |
| 데모 로그인 (NAME-2) | 🟡 | Claude 확인 |
| **REPORT · CAP · INQ · DONE · UX-1~4 · NAME-1 · 3~5** | ➖ | 체크아웃이 막혀 아직 못 감 (INQ · UX-1~4 일부는 막히지 않음) |

피드백과 고치는 아이디어: [feedback-2026-10-08.ko.md](feedback-2026-10-08.ko.md).

### 3.1 오너 — 돌봄 할 일 (CARE)

| ID | 단계 | 기대 결과 | 자동 | 상태 |
| :--- | :--- | :--- | :--- | :--- |
| CARE-1 | Demo owner → Home → Max → 아래 **Care tasks** → **Add task** → Medication, 이름·용량 입력 → Save | "Added …" 토스트, 목록에 "8:00 AM · every day · 용량" | 🤖 `care-tasks` | 🟡 10/04 Claude가 실 DB로 확인 — 사람 확인 필요 |
| CARE-2 | Mochi(고양이)에서 Add task | **Walk가 목록에 없음** (Litter는 있음). Max는 반대 | 🤖 `care-tasks` | ✅ 10/04 민식 |
| CARE-3 | 이름을 비우고 Save | "Give the task a name." | 🤖 `care-tasks` | ➖ |
| CARE-4 | 태스크 **Pause** → **Resume** → **Delete**(확인 시트) | Paused 표시 → 복귀 → 취소하면 남고, 확인하면 사라짐 | 🤖 `care-tasks` | ➖ |
| CARE-5 | **시간 칸을 탭** → iPhone처럼 **시 · 분 · AM/PM 휠**이 뜸. 손가락/마우스로 돌리거나 마우스 휠로 굴리거나, 줄을 눌러 고름 → Set | 가운데 띠에 멈춘 값이 선택됨 (예: 8:05 PM). + 버튼 없이 바로 | 🤖 `care-tasks` | ➖ |
| CARE-6 | 목록의 **태스크를 탭** → 이름 · 용량 · 시간 · 메모 수정 → Save changes | "Saved …" (시간을 바꾸면 "Saved — now at 6:45 PM"). **종류는 잠겨 있음** | 🤖 `care-tasks` | ➖ |
| CARE-7 | 시터가 아직 안 한 오늘 할 일의 **시간을 바꾸거나 Pause** | 시터 화면에서 옛 시각의 할 일이 사라지고 새 시각으로 나타남 (Missed로 남지 않음) | SQL `rls_smoke` · **실제 확인 👤** | ➖ |
| REQ-1 | Home → Max → Care tasks → **✍️ Write a care checklist** (돌보는 중이면 "care request") → 칩 **Meals** | 글상자는 **비어 있고 연한 힌트**("1 cup of kibble")만 보임. 비워 두고 Add line 하면 힌트 문구가 쓰임. 고양이는 **Walk 칩이 없음**. 칩마다 기본 문구가 다름 | 🤖 `care-request` | ➖ |
| REQ-2 | 시간 선택: **At a time**(휠) 또는 **Several times**(− 3 times +) — 둘 다 **Every day / Once** 선택 → **Add line** | 줄이 위 목록에 쌓이고 **새 칩 줄**이 이어서 나타남. Several times는 하루에 균등 배치(8 AM · 2 PM · 8 PM) 후 표에서 시간 수정 가능. **Heads-up** 칩은 글만 입력 | 🤖 `care-request` | ➖ |
| REQ-3 | **Make a checklist** | **표**(Time · Task)가 나타남. 줄마다 AI가 따로 다듬음(이름 · 용량 · 메모) — AI가 안 되거나 거절하면 내가 쓴 그대로 남고 **에러 없이** 진행. AI가 뺀 항목은 **빨간 "Left out" 박스**(탭하면 사라짐). 다시 줄을 쓰고 **Add to the checklist**로 같은 표에 추가 | 🤖 `care-request` · **실제 AI 👤** | ➖ |
| REQ-4 | (돌보는 중이 아닐 때) 표가 만들어지는 순간 | **자동 저장**: "Saving…" → **"✓ All changes saved"**. 이름 · 용량 · 시간 고치면 저장됨. 펫 화면 Care tasks에 바로 보임. **Save 버튼 없음**(Done만) | 🤖 `care-request` | ➖ |
| REQ-5 | 표에서 행 **Remove** | 바로 삭제 저장 + 아래 **"Removed … · Undo"** 8초. Undo → 행이 돌아오고 다시 저장됨 | 🤖 `care-request` | ➖ |
| REQ-6 | 한 번에 13개 이상 / 글 없는 줄 | 글이 없으면 **Add line** 비활성. 12개 초과면 "A checklist holds 12 tasks…" 팝업 | 🤖 `care-request` | ➖ |
| REQ-7 | **돌보는 중**(수락된 예약, 아직 픽업 전)인 펫에서 같은 화면 | 제목이 **"Write a care request"**, 자동 저장 없음("Nothing changes until Chloe approves"). **Send request to Chloe** → 토스트, 펫 화면에 "⏳ Waiting for Chloe…". 승인 전엔 Care tasks에 아무것도 안 생김. 대기 중엔 또 보낼 수 없음 | 🤖 `care-request` · SQL `rls_smoke` | ➖ |
| REQ-8 | 시터: Home에 **"📝 Care request for Max — tap to answer"** 줄(또는 알림) → 요청 화면 → **Approve** | 할 일 · Heads-up이 Max에 생성(한 번만 하는 건 once). 오너에게 "approved" 알림 | 🤖 `care-request` · SQL | ➖ |
| REQ-9 | 시터: **Decline or reply…** → 이유 칩(선택) 및/또는 **노트**(200자) → Decline | 아무것도 생성 안 됨. 오너 알림 본문에 이유 + 노트. 이유도 노트도 없으면 Decline 비활성 | 🤖 `care-request` · SQL | ➖ |
| REQ-10 | **실제 두 계정**: 오너가 요청 → 시터 화면 확인 → 답변 → 오너 확인 | 위 흐름이 새로고침 없이 이어짐(시터 알림 · 오너 알림) | **👤만** | ➖ |
| REQ-11 | 시터: 노트를 쓰면 **Counter-request** 상자가 나타남 → 추가 비용($, 선택) + "이 할 일은 오너가 해 주세요" 선택 → **Send counter-request** | 아무것도 생성 안 됨, 요청은 열린 채(오너가 답하기 전엔 새 요청 불가). 오너에게 알림 | 🤖 `care-request` · SQL | ➖ |
| REQ-12 | 오너: 펫 화면 **counter-reply 상자** (노트 · Extra fee · "You'd do yourself: …") → **Accept** / **Decline** | Accept → 시터가 맡기로 한 할 일 + Heads-up만 생성(오너가 하기로 한 할 일은 제외), 시터에게 알림. Decline → 닫힘, 아무것도 생성 안 됨. (비용은 기록·표시만 — 데모엔 추가 결제 없음) | 🤖 `care-request` · SQL | ➖ |
| REQ-13 | 돌보는 중(수락된 예약, 아직 픽업 전)인 펫의 펫 화면 | **Add task 버튼이 없음**, Heads-up의 직접 입력칸도 없음("A stay is on — … care request로"). 서버도 거절(오너가 직접 추가 시 42501). 이미 있는 할 일의 **수정 · 삭제는 그대로** 가능. 집에 있는 펫은 예전처럼 직접 추가 | 🤖 `care-request` · SQL `rls_smoke` | ➖ |
| HEADS-1 | 오너: 펫 화면 맨 아래 **Heads-up** 칸 → 문구 입력 → **Add Heads-up** | 칩으로 추가됨, 입력칸 비워짐. 같은 문구(대소문자만 다름)를 또 넣어도 중복 안 됨. 칩의 ✕ → 삭제. 없으면 "None yet…" 안내 | 🤖 `heads-up` | ➖ |
| HEADS-2 | 시터 Home (돌보는 중) | **한 줄 카드** "⚠️ Max: Text instead of knocking  +2". 카드를 누르면 펫별(+오너 이름)로 전부 보임. Home은 여전히 한 화면 | 🤖 `heads-up` | ➖ |
| HEADS-3 | 시터: 예약 상세(요청 수락 전 포함) | 펫 카드 **맨 위에 "⚠️ Heads-up" 상자**. 꺼 둔(inactive) 것은 안 보임, 없으면 상자 자체가 없음 | 🤖 `heads-up` | ➖ |
| HEADS-4 | 케어 요청서에서 저장한 Heads-up | 오너 펫 화면 · 시터 Home · 예약 상세에 **같이** 나타남 | 🤖 (각각) · 전체 흐름 👤 | ➖ |

### 3.2 시터 — 오늘 할 일 (TASK) · *사전: 오너가 태스크를 만들어 둠*

| ID | 단계 | 기대 결과 | 자동 | 상태 |
| :--- | :--- | :--- | :--- | :--- |
| TASK-1 | Demo sitter → Home → **All tasks** | 오늘 시각의 태스크가 시간순, 위에 "N left · M done"과 **Next up**. 일시중지한 태스크는 없음 | 🤖 `sitter-tasks` | ➖ |
| TASK-2 | 할 일의 **Done** | **팝업**이 뜸(메모 칸 · 📷 Add photo · Done). 이 시점엔 아무것도 전송되지 않음 | 🤖 `sitter-tasks` | ➖ |
| TASK-3 | 팝업에서 메모 없이 **Done** | "… done ✅ Robert was told" 토스트, **할 일이 목록에서 사라짐**, "Done today (N)"에 나타남. 오너 알림 제목은 **한 일**(예: "Max had breakfast on time 🍽️"), Feed 새 글 없음 | 🤖 `sitter-tasks` | ➖ |
| TASK-4 | 팝업에 **메모를 쓰고 Done** | 오너 알림에 **한 일(제목) + 메모(본문)** 이 같이 감 — 무엇에 대한 메모인지 알 수 있음 | 🤖 `sitter-tasks` · SQL | ➖ |
| TASK-5 | 팝업 **📷 Add photo** → 찍기/고르기/샘플 → 미리보기 → Use this photo → Done | 업로드 + 완료. 오너 Feed에 사진 글. 알림은 `task_done` 하나 | 🤖 `sitter-tasks` · **실제 업로드 👤** | ➖ |
| TASK-6 | 미리보기에서 **Retake** | 선택 화면으로 복귀, 아무것도 올라가지 않음 | 🤖 `sitter-tasks` | ➖ |
| TASK-7 | 업로드가 **실패**하면 | **빨간 팝업이 닫을 때까지 남음** + Try again. 팝업의 메모는 유지, 완료는 안 됨. Try again → 성공 | 🤖 `sitter-tasks` · **실제 환경 👤** | ➖ |
| TASK-8 | 예정 시각이 60분 넘게 지난 미완료 할 일 | ⚠️ Missed 배지 (60분 안이면 ⏳ Pending) | 🤖 `care-tasks` | ➖ |

### 3.3 시터 — Home 대시보드 · 빠른 체크인 (HOME / CHK)

| ID | 단계 | 기대 결과 | 자동 | 상태 |
| :--- | :--- | :--- | :--- | :--- |
| HOME-1 | 돌보는 중에 시터 Home | **스크롤 없이 한 화면**: 숫자 칩 · **Today 카드(오늘 남은 할 일 최대 3줄, 시간 전에도 보임; 나머지는 "+ N more")** · Now caring 펫 칩 · 바로가기 2개 | 🤖 `sitter-home` | ➖ |
| HOME-2 | Today 카드 줄의 **Done** (시간 전이어도 가능) | 팝업 → Done → 숫자(예: 1/4)가 바로 올라가고 다음 할 일이 올라옴. 지난 건 ⚠️ Overdue, 시간이 된 건 ⏰ Due now 표시 | 🤖 `sitter-home` | ➖ |
| HOME-3 | 바로가기 **All tasks · My history** (Photos · Bookings는 탭과 중복이라 뺌), 펫 칩 | 각각 해당 화면으로. 펫 칩 → 그 펫의 체크인 화면 + 📸 Photos 버튼 | 🤖 `sitter-home` | ➖ |
| HOME-4 | **My history** | 내가 끝낸 할 일 · 보낸 체크인(펫 이름 포함)이 최신순. 시간이 지난 미완료는 ⚠️ Missed로 | 🤖 `sitter-home` | ➖ |
| HOME-6 | 할 일 💤 스누즈 중에 Home | Next up 카드에 **"💤 Snoozed until 11:43 AM"** (할 일의 예정 시각은 그대로) | 🤖 `due-reminder` | ➖ |
| REM-1 | 시터 Home을 연 상태에서, 시간이 된(지난 지 1시간 안) 할 일이 있음 | **"⏰ Due now" 알람 팝업**이 화면 가운데 뜸(소리 · 진동 시도). **Done**으로 바로 완료, 팝업 뒤 Home엔 Today 목록이 그대로 | 🤖 `due-reminder` · 소리/진동 **👤** | ➖ |
| REM-2 | 앱을 켜 둔 채로 다음 할 일 시간이 됨 (30초마다 확인) | **"⏰ Time for Dinner · Max"** 토스트가 한 번 뜸. 이미 시간이 지난 할 일들 때문에 앱을 켤 때 토스트가 쏟아지지는 않음 | 🤖 `due-reminder` · **실제 시계 👤** | ➖ |
| REM-3 | 팝업의 **Dismiss** | 다음 할 일 팝업으로 넘어감. 1시간 넘게 지난 것은 **"⚠️ Overdue"**. 모두 닫으면 팝업 사라짐 | 🤖 `due-reminder` | ➖ |
| REM-4 | 급한 게 여러 개 | 가장 이른 것 하나 + "+ N more waiting — see all tasks" (누르면 전체 할 일) | 🤖 `due-reminder` | ➖ |
| REM-6 | 팝업의 **💤 Remind me in 10 min** | 팝업이 사라지고 Today 카드 줄에 **"💤 Snoozed until …"**. **새로고침해도 유지**. 10분 뒤 **"⏰ Still waiting: Dinner · Max"** 토스트와 함께 팝업이 다시 뜸 | 🤖 `due-reminder` | ➖ |
| REM-5 | **실제 시계로**: 오너가 2~3분 뒤 시각의 할 일을 만들고, 시터는 Home을 연 채 기다림 | 30초 안에 Today 목록에 나타나고, 그 시각 정각에 토스트 + 팝업 | **👤만** | ➖ |
| HOME-5 | (돌보는 중이 아닐 때) 시터 Home | 요청 배너 · 오늘 인계 · 다가오는 예약이 짧게 | 🤖 `today` | ➖ |
| CHK-1 | 체크인 화면 → Max의 Meal **All** 누르기 (메모 비움) | 버튼이 **"✓ All"** 로 선택만 됨(**아직 전송 안 됨**), "Ready to send: …" 안내, 다시 누르면 선택 해제. **Send**를 눌러야 전송 → 토스트 "Sent ✅", 오너 알림 "Max ate everything 🍽️" | 🤖 `quick-checkin` | ➖ |
| CHK-2 | 카드 아래 **"Sent to Robert today"** 목록 | 방금 보낸 것이 시각과 함께 쌓임 (메모는 따옴표로) | 🤖 `quick-checkin` | ➖ |
| CHK-3 | 메모 칸에 글을 쓰고 Meal **A little** | 오너 알림: **보낸 것(제목) + 메모(본문)**. 전송 후 메모 칸 비워짐 | 🤖 `quick-checkin` | ➖ |
| CHK-4 | 아무것도 고르지 않고 메모만 쓰기 | 메모가 없으면 **Send 비활성**. 메모를 쓰면 "Ready to send as a note" → Send로 노트 전송 | 🤖 `quick-checkin` | ➖ |
| CHK-5 | Max에는 Walk 10–60분 있음, Mochi에는 **없음** | 펫마다 체크인 화면이 따로, 고양이는 산책 없음 | 🤖 `quick-checkin` | ➖ |
| CHK-6 | **📷 Add photo** → 선택 → 미리보기 → Use → Mood **Happy** | "Photo ready ✓", 전송 시 업로드. 오너 Feed에 사진 글 + 체크인 알림 하나 | 🤖 `quick-checkin` · **실제 업로드 👤** | ➖ |
| CHK-7 | 전송이 **실패**하면 | 빨간 팝업이 남고 Try again으로 다시 보냄 | 🤖 `quick-checkin` | ➖ |

### 3.4 Feed · 공개 범위 (FEED / VIS)

| ID | 단계 | 기대 결과 | 자동 | 상태 |
| :--- | :--- | :--- | :--- | :--- |
| FEED-1 | 시터: Feed 탭 → Max → **+ Photo** → 샘플 | "Shared with Robert 🐾", 그리드에 새 사진 | 🤖 `media-picker` | ➖ |
| FEED-2 | **두 브라우저**: 일반 창 = 오너, 시크릿 창 = 시터. 시터가 올림 | 오너 화면에 **새로고침 없이** 토스트 + 벨 숫자 + Home 카드 + Feed 카드 (≤ 3초) | **👤만** (실시간) | ➖ |
| FEED-3 | 오너: 사진 탭 | **탭한 그 사진**이 전체화면. ‹ › 버튼, 스와이프, ←/→ 키 이동 | 🤖 `feed` | ➖ |
| FEED-4 | 영상 샘플 (Fetch play) 재생 | 오너 전체화면에서 재생 | 👤 | ➖ |
| FEED-5 | 시터가 **자기 사진** 열기 → 🗑️ → 확인 | "Photo deleted", 오너 Feed에서도 사라짐. 오너 화면에는 시터 글의 🗑️ **없음** | 🤖 `feed` · 파일 삭제는 pytest | ➖ |
| FEED-6 | 사진 업로드가 **실패**하면 | 빨간 팝업이 남고 Try again | 🤖 `media-picker` | ➖ |
| VIS-1 | 시터: **Share with Robert** 칩 끄기("Only you") → 사진 올리기 | "Saved just for you 🔒", 🔒 배지. **오너는 못 봄**, 알림 없음 | 🤖 `media-picker` · SQL | ➖ |
| VIS-2 | 오너: Feed → **+ Photo** (기본 "Only you") | "Saved just for you 🔒". 시터는 못 봄 | 🤖 `media-picker` · SQL | ➖ |
| VIS-3 | 오너: "Visible to sitter" 켜고 올림 | 당직 시터가 알림 "Robert shared a photo of Max 📸" → 탭 → 시터 Feed → Max, 사진 보임 | 🤖 SQL · e2e (알림 이동) | ➖ |

### 3.5 알림 (NOTIF)

| ID | 단계 | 기대 결과 | 자동 | 상태 |
| :--- | :--- | :--- | :--- | :--- |
| NOTIF-1 | 오너: 벨 → 알림 목록 | **둥근 카드** 한 장씩, 최신순, 안 읽은 것 강조, 벨 숫자 | 🤖 `feed` | ➖ |
| NOTIF-2 | 알림 탭 | 읽음 처리 + 해당 화면 (`feed_post` → Feed, 할 일 · 체크인 → **History**), **그 알림의 펫**으로 열림(Mochi 알림 → Mochi). 사진/메모가 있으면 **먼저 크게 보여 주고** 닫으면 이동 | 🤖 `feed` · `live-updates` | ➖ |
| NOTIF-8 | 사진이 달린 알림 | 목록/카드 오른쪽에 **작은 사진 썸네일**. 탭 → 큰 사진 + 메모 시트. **Close는 그냥 닫힘**, "See in History" 버튼을 눌러야 History | 🤖 `live-updates` · 실제 사진 **👤** | ➖ |
| NOTIF-3 | **Mark all as read** | 숫자 사라짐 | 🤖 `feed` | ➖ |
| NOTIF-4 | 알림 한 줄을 **왼쪽으로 60% 넘게 밀기** | 카드와 같은 **둥근 모양의 빨간 Delete**가 드러나고, 놓으면 사라지며 삭제됨(가만히 있을 땐 빨간 부분이 안 보임). 벨 숫자 갱신 | 🤖 `feed` | ➖ |
| NOTIF-5 | 알림 한 줄을 **덜 밀다 놓기** | 제자리로 돌아오고 유지됨. 탭은 여전히 열림 | 🤖 `feed` | ➖ |
| NOTIF-6 | **Clear all** → 확인 | 확인 시트("Clear 2 notifications") 후 전부 삭제, "You're all caught up." | 🤖 `feed` | ➖ |
| NOTIF-7 | 한꺼번에 사진 여러 장 | 토스트는 "3 new photos 📸" 하나로 합쳐짐 | 👤 | ➖ |

### 3.6 오너 Home · History · Diary (LIVE / HIST)

| ID | 단계 | 기대 결과 | 자동 | 상태 |
| :--- | :--- | :--- | :--- | :--- |
| LIVE-1 | 시터가 할 일 · 체크인 · 사진을 남긴 뒤 오너 Home | 맨 위 **Live updates**에 최신 3개 카드(할 일 완료 · 체크인 · 새 사진만; 메모가 있으면 제목 아래에 같이). 예약 알림 등은 안 나옴. **눌러서 확인한(읽은) 카드는 Home에서 사라짐**(알림 목록과 History엔 남음 — 안 읽은 것만 Home에 남음). 3개 넘으면 "N more in notifications" | 🤖 `live-updates` | ➖ |
| LIVE-2 | 카드를 **왼쪽으로 60% 넘게 밀기** | 카드가 사라지고 알림도 삭제. 다음 카드가 올라옴. **History에는 그대로 남음** | 🤖 `live-updates` | ➖ |
| LIVE-3 | 카드를 덜 밀기 / 탭 | 덜 밀면 유지. 체크인 · 할 일 카드 탭 → History, 새 사진 카드 → Feed | 🤖 `live-updates` | ➖ |
| LIVE-6 | 맨 위 카드 오른쪽 **✕** → **Clear all** (Cancel도 있음) | 보이는 Live updates(할 일 · 체크인 · 사진 알림)만 전부 삭제, 예약 알림 등은 남음 | 🤖 `live-updates` | ➖ |
| LIVE-7 | 오너 Home 펫 카드 | 지금 시터가 맡은 펫은 **카드 배경이 연한 초록 + 굵은 테두리 + 왼쪽 위 테두리에 "In care" 태그**, 이름 아래 "with Chloe · until Oct 7, 1:37 AM". 집에 있는 펫은 평범한 카드 | 🤖 `live-updates` | ➖ |
| LIVE-8 | 시터가 요청을 **Decline** 함 | 오너 Home 맨 위에 **주황 테두리 카드가 고정**("Tap to read and answer"): 밀어서 못 지움 · Clear all에도 남음 · 새로고침해도 남음. 탭 → 노트 시트(**Close는 그냥 닫힘**) → **읽으면 Home에서 사라짐**(답은 펫 화면 빨간 상자에 남음) | 🤖 `care-request` | ➖ |
| LIVE-9 | 시터가 **Counter-request** 를 보냄 | 같은 고정 카드. 읽어도 **오너가 Accept/Decline 하기 전까지 Home에 남음**, 답하면 사라짐 | 🤖 `care-request` | ➖ |
| LIVE-4 | 새 업데이트가 없을 때 | "Nothing new. During a stay, …" 안내 | 🤖 `live-updates` | ➖ |
| LIVE-5 | **두 브라우저**: 오너가 Home을 연 채 시터가 체크인 | 오너 Home에 **새로고침 없이** 카드 추가 | **👤만** (실시간) | ➖ |
| HIST-1 | Home의 **🕘 History** | 오늘 · 어제 · 날짜별 **최신순**, 줄마다 이모지 · 문구 · 시각 · 사람 · 썸네일 | 🤖 `diary` | ➖ |
| HIST-2 | 사진과 함께 완료/체크인 | 같은 사진이 **한 줄로만** (Feed 사진과 중복 안 됨) | 🤖 `diary` | ➖ |
| HIST-3 | 메모가 있는 체크인 / 7일보다 오래된 기록 | 메모가 줄 아래에 보임 / 오래된 건 안 보임 | 🤖 `diary` | ➖ |
| HIST-4 | 시간이 지난 미완료 할 일 | ⚠️ "… · Missed" | 🤖 `diary` | ➖ |
| HIST-5 | 줄 탭 | 사진이 있으면 크게, 없으면 상세(시각 · 사람 · 메모) | 🤖 `diary` | ➖ |
| HIST-6 | 펫이 둘이면 칩으로 전환 | 펫마다 자기 기록만 | 🤖 `diary` | ➖ |
| DIARY-1 | 오너 **Diary 탭** | "시터가 하루를 정리해 쓰면 여기에 나타나요" 안내 + Open History 버튼 (일기 쓰기는 Phase 07) | 🤖 `live-updates` | ➖ |
| DIARY-7 | (이전 화면에서 확인) 새로고침 없이 새 줄 추가 | 같은 동작이 이제 **Home 카드(LIVE-5)** 로 옮겨감 — 재확인 | **👤만** | ✅ 10/04 민식 (이전 Diary 화면) |

### 3.7 보안 · 권한 (SEC) — 실제 DB에서 👤

| ID | 단계 | 기대 결과 | 자동 | 상태 |
| :--- | :--- | :--- | :--- | :--- |
| SEC-1 | 다른 오너 계정으로 로그인 | Robert의 Max/Mochi 피드 · 알림 · 체크인이 **보이지 않음** | SQL `rls_smoke` | ➖ |
| SEC-2 | 시터로 `/owner` 주소를 직접 입력 | 시터 화면으로 되돌아감 | 🤖 `auth` | ➖ |
| SEC-3 | 오너가 체크인 · 할 일 완료를 API로 직접 시도 | 거절 (돌봄 구간의 시터만 가능) | SQL `rls_smoke` | ➖ |

### 3.8 예약 · 미팅 · 결제 (BOOK) — 이전 Phase, 자동 테스트가 촘촘함

| ID | 확인 내용 | 자동 | 상태 |
| :--- | :--- | :--- | :--- |
| BOOK-1 | 예약 요청 → 시터 수락 → 확정 | 🤖 `booking` · `sitter-bookings` | 🟡 10/08 민식 — 요청 → 수락 → Confirmed까지 진행됨 (오너 화면이 실시간으로 안 바뀜 → FLOW-1) |
| BOOK-2 | 시간 · 장소 협상, 확정 후 변경 | 🤖 `negotiation` | ❌ 10/08 민식 — 시간 변경 시트에서 값이 날아감 · "That handoff already happened." (FLOW-7~9) |
| BOOK-3 | 첫 만남 미팅 (제안 · 수락 · 건너뛰기) | 🤖 `meet-greet` | ➖ |
| BOOK-4 | Received → Returned, 취소 · 새 시터 찾기 | 🤖 `handoff` · `rebook` | ❌ 10/08 민식 — Returned가 확인 없이 바로 처리됨 (FLOW-6) |
| BOOK-5 | 견적 → 동의서 → 데모 결제 → 출입 정보 잠금 해제 | 🤖 `checkout` · SQL | ❌ 10/08 민식 — Finish booking → "This sitter doesn't offer that service." (`sitter_rates` 비어 있음, FLOW-3) |
| BOOK-6 | **영상 미팅 Google Meet 링크** (앱에서) | 서버만 확인 (**앱 e2e 미확인**, 3B.11) | ➖ |

### 3.9 리뷰 버그 수정 (BF) — 2026-10-06 코드 리뷰에서 나온 버그

| ID | 확인 내용 | 기대 결과 | 자동 | 상태 |
| :--- | :--- | :--- | :--- | :--- |
| BF-1 | 시터가 handoff 사진 업로드 (`purpose=handoff`) | 확정 예약의 시터만, 합의된 맡기기 2시간 전부터 찾기 2시간 뒤까지 서명 발급. 그 밖에는 403 (예전엔 없는 컬럼을 읽어 **항상 500**) | pytest `test_authz_handoff` | ➖ |
| BF-2 | 사진을 붙인 체크인 → Feed에서 그 글을 🗑️ 삭제 | 피드 글만 지워지고 **Diary · History의 체크인 사진은 남음** (예전엔 Cloudinary 파일까지 지워짐) | pytest `test_feed_delete` | ➖ |
| BF-3 | 오너 · 시터가 거의 동시에 영상 미팅 링크를 받음 / 시터가 영상 미팅이 잡힌 요청을 Decline | 링크(캘린더 이벤트)는 **하나만** 남고 알림도 한 번. Decline하면 캘린더 이벤트도 지워짐 | pytest `test_meet_greet` (Decline 후 삭제는 👤 — Google 계정 필요) | ➖ |
| BF-4 | 돌봄 중 오너가 보낸 요청에 시터가 답하기 전에 예약이 취소되거나 찾기(Returned)가 끝남 | 요청이 **closed** 로 닫혀 다음 요청을 막지 않고, 예전 시터는 더 이상 승인할 수 없음 (시터 화면: "The stay ended before this request was answered."). 돌봄 중에는 저장형 체크리스트(`save_care_request`)도 거절 | SQL `rls_smoke` (BF.4) | ➖ |
| BF-5 | 오너가 찾기 시간 변경을 보낸 뒤 시터가 먼저 Returned · 지난 시간 제안 수락 · 하우스시팅 장소 변경 | Returned가 남은 제안을 닫아 **완료된 인수인계가 다시 열리지 않음**(출입 정보도 다시 안 열림). 지난 시간은 수락 불가, 픽업 시간이 지난 요청은 **Expired**로 Past에. 하우스시팅은 시간만 바꿀 수 있음 | SQL `rls_smoke` (BF.5) · 🤖 `sitter-bookings` · `negotiation` | ➖ |
| BF-6 | 결제한 예약에서 찾기 장소를 오너 집으로 바꾸고 시터가 수락 / 찾기 시간을 늦추고 수락 | 오너 집 → 체크아웃이 다시 열림(결제 취소, 지난 견적 유지) + 오너에게 `checkout_needed` 알림, 예약 화면 배너 "Your stay changed — sign to finish", Checkout에서는 **home_access 하나만** 체크하면 결제 완료. 그 전까지 시터의 출입 정보는 잠김. 기간 변경 → 새 총액으로 다시 견적 + `price_updated` 알림(결제 상태 유지). 동의서는 체크아웃 중(확정 · 미결제 · 필요한 종류)에만 서명. 오너 주소·긴급 연락처는 결제 후에만 시터에게 보임 | SQL `rls_smoke` (BF.6) · 🤖 `checkout` | ➖ |
| BF-7 | BF-6처럼 체크아웃이 다시 열린 상태에서 오너 · 시터가 예약 화면을 엶 | 오너: 시터 집 카드(주소 · 주차 · 로비)가 그대로 보임. 시터: 맡기기 · 찾기 주소(펫을 데려다줄 오너 집 포함)가 그대로 보이고, 출입 정보 카드는 사라지지 않고 "Waiting for {오너} to sign"을 보여 줌(코드는 서명 전까지 잠김). 한 번도 결제하지 않은 예약은 예전처럼 주소가 안 보임 | SQL `rls_smoke` (BF.7) · 🤖 `checkout` | ➖ |

### 3.10 알림장 (REPORT) — Phase 07 · *사전: 시터가 돌보는 중, 오늘 체크인 몇 개, 백엔드 + `NEBIUS_API_KEY`*

| ID | 단계 | 기대 결과 | 자동 | 상태 |
| :--- | :--- | :--- | :--- | :--- |
| REPORT-1 | 시터 → **Diary** 탭 | 펫이 둘 이상이면 맨 위 **펫 선택**(이름 + "Draft" / "Sent ✓") — 고른 펫 카드 하나만 보이고, 바꿔도 각 펫의 칩 · 줄이 남음 (FB-19). 카드 맨 위 **"Today: n tasks done · m missed · k check-ins"**, 그날 기록에서 만든 칩(식사 · 배변 · 산책 · 기분 · 약)이 모두 켜진 상태 | 🤖 `report` · pytest | ➖ |
| REPORT-2 | 칩을 눌러 **끄기** → **Write the report** | 미리보기에 **끈 칩의 내용이 없음**. 끈 칩은 서버로 `skip`으로 감 | 🤖 `report` · pytest | ➖ |
| REPORT-3 | **✎ Fix a recorded value** → 식사를 Most로, 산책 30 min으로 | 칩 문구가 "Meal: Most" · "Walk: 30 min"으로 바뀌고 알림장에도 그 값이 쓰임. 그 칩을 끄면 고친 값도 안 감 | 🤖 `report` · pytest | ➖ |
| REPORT-4 | **Anything to add?** 칸에 짧은 줄("Learned a new trick") → Add(또는 Enter), 몇 줄 더 | 줄마다 내 칩이 생기고 칸은 비워짐. 켜 두면 알림장에 **맨 앞**으로 반영, 끄면 빠짐. 내 칩만 **×**로 지울 수 있음(제안 칩은 끄기만). 칸을 비우면 아무것도 안 생김 (FB-16 · 17 · 18) | 🤖 `report` | ➖ |
| REPORT-5 | **📷 Add photo** (최대 2장) → 사진 추가 | 사진 묘사 한 줄 + 에피소드 칩 1–2개가 생김(📷 표시). 사진을 지우면 그 칩도 사라짐. 사진 칩을 전부 끄면 그 사진 내용은 알림장에 안 들어감 | 🤖 `report` (AI는 mock) · **실제 모델 👤** | ➖ |
| REPORT-6 | Write the report → 미리보기 **직접 고치기** → **Send to {owner}** | "Sent ✅ … was told". 오너가 받는 글은 **시터가 고친 최종본**. 같은 날 다시 Write하면 덮어쓴 초안(보낸 뒤엔 불가) | 🤖 `report` · SQL | ➖ |
| REPORT-7 | 초안을 만든 뒤 앱 새로고침 | 초안이 그대로 다시 보임 (오너에게는 보내기 전까지 안 보임) | 🤖 `report` | ➖ |
| REPORT-8 | 기록이 하나도 없는 날 Write the report | 고정된 짧은 인사 문장만 (모델을 안 부름, 지어내지 않음) | 🤖 pytest | ➖ |
| REPORT-9 | 오너 → **Diary** 탭 | 보낸 알림장만 날짜순 카드(첫 문장 미리보기). 카드 → 본문 · 그날 사진 스트립 · 할 일 체크리스트. 초안은 절대 안 보임 | 🤖 `report` · SQL | ➖ |
| REPORT-10 | **실제 두 계정**: 시터가 Send → 오너 벨 알림 → 탭 | 알림을 누르면 해당 알림장 항목이 열림. 새로고침 없이 이어짐 | **👤만** | ➖ |
| REPORT-11 | Diary를 연 채로 Home에서 체크인(메모 포함) → Diary로 돌아옴 | 그 메모가 칩으로 바로 보임(새로고침 불필요). 꺼 둔 칩은 꺼진 채 (FB-15 · M-12) | 🤖 `report` | ➖ |
| REPORT-12 | 알림장 Send 뒤 **✏️ Write another report** → 줄 추가 → Write → Send | 새 칩은 **첫 알림장을 보낸 뒤의 기록**만. 두 번째 알림장이 따로 저장 · 전송되고 오너 Diary에 같은 날 두 장(나중 것이 위) (FB-22) | 🤖 `report` · pytest · SQL 011f | ➖ |
| REPORT-13 | `in_care`로 리셋하자마자(3분 안) Feed에 사진 1장 + 체크인 1개 → Diary | 체크인이 바로 저장되고, 그 사진 캡션 · 체크인이 칩으로 나옴 — 일찍 Received한 뒤의 기록도 그날 알림장에 들어감 (CW-1) | pytest · SQL 011i (호스팅 DB에 `011i` 적용 뒤) | ➖ |

### 3.11 문의 AI (INQ) — Phase 07B · *사전: 백엔드 + `NEBIUS_API_KEY`, Chloe의 일정 · 요금이 있고 Robert에게 Max(+Mochi)가 있음*

| ID | 단계 | 기대 결과 | 자동 | 상태 |
| :--- | :--- | :--- | :--- | :--- |
| INQ-1 | 오너 → Chloe 프로필 → **Ask before booking** → 반려동물 · 날짜 · 질문("Can you give Max his pill at 2 PM?") → **Send** | 시트가 닫히고 대화 화면. 내 질문 말풍선, "Chloe will reply soon". **시터가 보내기 전에는 답이 안 보임** | 🤖 `inquiry` | ➖ |
| INQ-2 | 질문을 비우고 Send | 질문 자리에 "Boarding · Oct 9 – Oct 12 · Max" 같은 한 줄 요약이 감 | 🤖 `inquiry` | ➖ |
| INQ-3 | 시터 → Bookings → **Questions (1)** → 문의 카드("✍️ Draft ready") → 열기 | 경고 문구 "AI drafts can be wrong. You're responsible for what you send.", **시터 1인칭** 초안, 견적 카드(03C와 **같은 금액**), 출처 칩. 열면 오너 질문이 읽음 처리 | 🤖 `inquiry` · pytest · **실제 모델 👤** | ➖ |
| INQ-4 | 초안의 금액 · 날짜가 서버 값과 같은가 (Thanksgiving 포함 3박 2마리 → $268.13 CAD) | 금액 = 견적 total, 날짜는 문의한 기간 안, `{PRICE}` 같은 자리표시자 없음 | pytest a–c · h | ➖ |
| INQ-5 | 시터가 **Send** 한 번 (타이핑 없이) | "Sent ✅ … was told". 오너 대화에 **AI 라벨 없는 시터 말풍선** + 견적 카드 + "From Chloe's policies" 칩 + **Request booking** | 🤖 `inquiry` · SQL | ➖ |
| INQ-6 | 시터 **Edit / Add** → 고쳐서 Send | 오너가 받는 글 = 고친 글. (학습: `edited` + 수정 비율 기록) | 🤖 `inquiry` · pytest | ➖ |
| INQ-7 | 시터 **Regenerate** · 의도 칩(Accept / Decline / Suggest other dates) | 새 초안이 뜨고 방향이 바뀜(Decline이면 정중한 거절, 가격 문장 없음) | 🤖 `inquiry` · pytest | ➖ |
| INQ-8 | 시터가 문의 기간 중 하루를 **block** 한 상태로 같은 문의 | 초안이 "그날은 어렵다 + 다른 날짜/다른 시터" 안내, **가격 문장 없음**. 오너에게는 **Find other sitters**만 (Request booking 없음) | 🤖 `inquiry` · pytest a | ➖ |
| INQ-9 | 시터 정책에 "No dogs over 20 kg." + 25 kg 반려동물로 문의 | 초안이 "확인하겠다"로 안내하고 **⚠️ Check this one** 표시 (자동 발송 안 됨) | pytest d | ➖ |
| INQ-10 | 질문에 "Are you an AI?" | 사람이라고 답하지 않음 · 시터에게 "reply yourself" 별도 알림 · 자동 발송 안 됨 | pytest i | ➖ |
| INQ-11 | 오너 **Request booking** | `/owner/bookings/new`에 서비스 · 반려동물 · 시간 · 장소 · 시터가 **채워진 채** 열림. 요청을 보내면 그 문의가 booked | 🤖 `inquiry` | ➖ |
| INQ-12 | 시터 `/profile` → **House rules & policies** 저장 | 저장되고 백그라운드에서 재색인. 이후 초안이 그 규칙을 근거("From Chloe's policies")로 씀 | 🤖 `inquiry` · pytest · **실제 DB 👤** | ➖ |
| INQ-13 | 시터 `/profile` → **AI replies → Auto-send** | 책임 동의 모달("Replies go out in your name…") 확인 후에만 켜짐. 껐다 켜면 모달 없음 | 🤖 `inquiry` · SQL | ➖ |
| INQ-14 | **자동 모드 시터에게** 오너가 문의 | 대기 없이 초안 생성 → 오너 화면 "Chloe will reply soon" → **약 4초 뒤 "Chloe is typing…"** → **약 15–40초(보통 ≈ 30초) 뒤 답 말풍선** + 그 시각에 알림. 시터가 스레드를 열기 **전엔 "Read" 표시가 없음**. 시터 화면에는 "Sent automatically" | 🤖 `inquiry` · pytest | ➖ |
| INQ-15 | 자동 모드인데 초안이 확인이 필요한 경우(정책 충돌 · AI 질문 · 모델 실패) | **자동 발송 안 됨** — 수동 초안으로 시터에게 | pytest | ➖ |
| INQ-16 | 시터 말투 비교: Chloe(경쾌) vs Paul(차분) 같은 질문 | 초안 말투가 뚜렷이 다름 (금액 · 날짜는 둘 다 서버 값). 약 50건 블라인드 평가는 슬기 | 실제 모델 확인 · **평가 👤** | ➖ |
| INQ-17 | **실제 두 계정** 전체 흐름 (문의 → 초안 → Send → 오너 알림 → Request booking) | 새로고침 없이 이어지고 오너는 초안을 한 번도 못 봄 | **👤만** | ➖ |
| INQ-18 | **보안 (실제 DB 👤)**: 제3자 · 다른 시터가 남의 문의 열기, 오너가 `author='ai'` 행 조회, 클라이언트가 `knowledge_chunks` · `tone_samples` 읽기 | 모두 0행 / 거부 | SQL `rls_smoke` M | ➖ |
| INQ-19 | 오너 → **Bookings** 탭 → **Your questions** | 내가 보낸 문의가 최신순으로 (시터 · 반려동물 · 날짜), 상태: "Waiting for Chloe" / "💬 Reply ready" / "Booking requested". 카드를 누르면 그 대화로. 시터가 아직 안 보낸 답(초안 · 자동 발송 대기 중)은 "Reply ready"로 안 보임 | 🤖 `inquiry` | ➖ |
| INQ-20 | 시터 일정에서 어느 하룻밤의 자리를 1로 줄임(그 밤 `max_pets` 1) → 오너가 **Max + Mochi**로 그 밤을 포함해 문의 | AI 초안이 **"가능해요" 대신 그 날짜는 못 한다**고 하고 견적 카드 · Request booking 없음 — 예약 요청을 해도 같은 판단(`sitter_unavailable`). 시터가 안 연 날짜가 끼어도 같음 (RV-1) | pytest · SQL 011c (호스팅 DB에 `011c` 적용 뒤) | 로컬 ✅ 10/09 민식 (Max+Mochi, 10/16 자리 1 → "unavailable on Oct 16", 견적 없음) · Vercel ➖ |
| INQ-21 | `pets`로 리셋(예약 이력 없음) → 오너가 Chloe에게 Max + Mochi 문의 → 시터 Bookings → **Questions** | 카드 제목이 **"Robert · Max, Mochi"**("An owner" 아님), 스레드 제목 · 여행 줄에 펫 이름. 머문 기간이 끝나거나 문의가 닫히면 펫 정보는 다시 안 보임(이름은 남음) (FB-31 · RV-4) | SQL 011e (호스팅 DB에 `011e` 적용 뒤) | ➖ |
| INQ-22 | Chloe 일정에서 하루를 Max pets 1로 → 오너가 Chloe 프로필 | 버튼이 **[Ask before booking] [Book]** 나란히. 문의 시트에서 Max만 고르면 그날 초록 점, **Max + Mochi**면 그날 **주황 점(Full)** + "Chloe has no room for your pets that day — you can still ask." 달력 아래 범례 (FB-33) | 🤖 `inquiry` | 로컬 ✅ 10/09 민식 · Vercel ➖ |
| INQ-23 | 시터가 답한 문의(가능/불가 아무거나)에서 오너 대화 화면을 연다 → **Write back** 칸에 "What about the weekend after?" → **Send** | 대화에 **모든 메시지가 시간순**으로 보임(내 질문 · 시터 답 · 새 질문). 보낸 뒤 "Chloe will reply soon"으로 돌아가고 입력칸 · 이전 답의 버튼은 사라짐. 새 초안이 생기며 시터에게 "your draft is ready" 알림. 자동 발송 시터면 같은 규칙으로 약 30초 뒤 답이 나타남 (시터 승인 · 자동 발송 규칙은 첫 문의와 동일) (FB-34) | 🤖 `inquiry` (오너 이어 쓰기) · AI 초안 자체는 pytest(#67) | 로컬 🤖 10/10 (브라우저로 실제 Supabase · 백엔드 · AI 실행 — 사람 ✅ 대기) · Vercel ➖ |
| INQ-24 | 시터가 **불가**로 답한 문의 → 오너 대화 | 큰 버튼 **Change dates**, 그 아래 글자 버튼 **Find other sitters**(보조). Change dates → 문의 시트가 **같은 서비스 · 반려동물 · 시간 · 장소**로 채워져 열림(지난 날짜면 오늘로) → Send → **새 문의**(이전 대화는 그대로)로 이동 (FB-34) | 🤖 `inquiry` | 로컬 🤖 10/10 (브라우저로 실제 Supabase · 백엔드 · AI 실행 — 사람 ✅ 대기) · Vercel ➖ |
| INQ-25 | 시터가 답한 문의에 오너가 새 메시지를 씀 → 시터 Bookings → **Questions** | 그 카드가 다시 **"Writing the draft…"**(Questions 숫자에 포함), 초안이 생기면 **"Draft ready"**, 열면 **새 질문에 대한 초안만** 보임(이전 초안 X) → Send 하면 "Replied" (목록 · 스레드 모두 마지막 오너 메시지 기준) (FB-34) | 🤖 `inquiry` | 로컬 🤖 10/10 (브라우저로 실제 Supabase · 백엔드 · AI 실행 — 사람 ✅ 대기) · Vercel ➖ |
| INQ-26 | 오너 · 시터 대화 화면의 시간 표기 | 메시지 · Drop-off · Pick-up 시간이 **"Oct 10, 1:05 PM"**(올해가 아니면 "Oct 10, 2027, 1:05 PM")으로 보임 ("10-10 1:05 PM" 아님) (FB-34) | 🤖 `inquiry` | ➖ |
| INQ-27 | 두 브라우저(오너 · 시터)에서 같은 대화를 열어 둔 채 한쪽이 보냄 | **새로고침 없이** 상대 화면에 메시지가 나타남(Realtime, 안 되면 5초 폴링). 시터 화면에 오너의 새 메시지가 뜨는 순간 오너 쪽엔 **Read**. 오너 화면에서 시터의 새 답도 바로 뜸 (FB-34) | 🤖 `inquiry` (폴링 경로) · Realtime 소켓은 👤 | ➖ |
| INQ-28 | 시터 초안에 **"From your earlier messages"** 칩 | 오너 · 시터 화면 어디에도 안 나옴(오너의 이전 메시지는 AI의 참고일 뿐, 출처 칩이 아님). 정책 · Life Record 출처 칩은 그대로 (FB-34) | 🤖 `inquiry` | ➖ |
| INQ-29 | 시터 일정에 자리가 없는 날로 온 문의의 초안을 시터가 연다 → Accept / Decline / Suggest other dates / Regenerate | 초안 위에 **"📅 Your calendar has no room … a draft can't say yes"** 안내, **Accept는 비활성**(자리가 없으면 "가능"이라 쓸 수 없는 RV-1 안전 규칙). Decline · Suggest · Regenerate는 새 초안을 만들고 **"New draft ready ✍️"** 토스트. 문구가 비슷해 보여도 정상 — 사실(자리 없음)이 같기 때문. 일정을 열고 Regenerate하면 가능 답이 나옴 (FB-34) | 🤖 `inquiry` (안내 · 비활성) · 실제 AI 답은 👤 | ➖ |
| INQ-30 | 시터에게 답 안 한 문의가 있고 다른 대기 요청 · 임박한 stay가 없을 때 | **Home**에 "💬 Questions (n) — tap to answer" 배너(누르면 Bookings). **Bookings 탭을 누르면 Questions 탭이 바로 열림**(요청이 있으면 Requests가 우선, 임박한 stay는 Upcoming). 직접 탭을 고른 뒤에는 자동으로 옮기지 않음. 답하면 배너가 사라지고, 오너가 새 메시지를 쓰면 다시 나타남. 면책 문구("AI drafts can be wrong…")는 **Send 아래 작은 회색 글씨** (FB-34) | 🤖 `inquiry` | ➖ |
| INQ-31 | 오너가 거절 답을 받은 대화에서 **Change dates** → 날짜 하루 뒤로(+) → **Send** | **같은 대화**에서 시트가 닫히고(새 문의 아님, URL 그대로) 내 말풍선 **"Changed dates: Oct 12, 9:00 AM – Oct 14, 5:00 PM"**이 이어 붙음. 픽업도 같은 길이만큼 같이 이동. 시터에게 "draft is ready" 알림, 새 초안은 **새 날짜** 기준(견적 · 자리 포함). 펫 · 서비스는 그대로 (011j, FB-34) | 🤖 `inquiry` (앱) · SQL 011j (호스팅 DB에 `011j` 적용 뒤) | ➖ |
| INQ-32 | 시터가 초안 아래 **Accept** | 팝업에 **수락 답장이 써져 있음**(AI, 시터 말투, 수정 가능, 견적 카드) → **Send acceptance** 하면 바로 대화에 전송. 자리가 없는 날이면 팝업은 "📅 no room … " 설명 + **Open my schedule**만 (가짜 "yes"는 안 나감) (FB-34) | 🤖 `inquiry` · 실제 AI 문구는 👤 | ➖ |
| INQ-33 | 시터가 **Decline** | 팝업에 거절 답장 → **Send decline** → 바로 전송. 오너 화면은 **Change dates**(Request booking · 견적 없음) (011k) | 🤖 `inquiry` · SQL 011k (`011k` 적용 뒤) | ➖ |
| INQ-34 | 시터가 **Suggest other dates** | 팝업에서 **날짜 · 시간을 고르고**(내 일정 달력 표시) 메시지에 그 날짜가 자동으로 들어감(수정 가능) → **Send suggestion**. 내 일정에 자리 없는 날을 고르면 빨간 안내 + Send 비활성. 오너는 Change dates로 이어 감 (FB-34) | 🤖 `inquiry` | ➖ |

### 3.12 사진 캡션 · 앨범 (CAP) — Phase 09 · *사전: 시터가 돌보는 중, 백엔드 + `NEBIUS_API_KEY`*

| ID | 단계 | 기대 결과 | 자동 | 상태 |
| :--- | :--- | :--- | :--- | :--- |
| CAP-1 | 시터 → Feed → 펫 → **+ Photo** → 샘플 사진 하나 | 피드 위에 **내 사진 썸네일 카드** + "Uploading…" → **"Writing a caption…"** → 토스트 "Shared with Robert". **글 입력칸이 어디에도 없음** | 🤖 `caption` | ➖ |
| CAP-2 | 게시된 카드의 캡션 | 1–2문장, 따뜻함, 펫 이름 한 번, 이모지 ≤ 2, **해시태그 · 따옴표 없음**, 사진에 안 보이는 것을 지어내지 않음. 샘플 5장 중 4장 이상이 사람이 쓴 듯 | **👤** | ➖ |
| CAP-3 | 샘플 meal · walk · nap 사진을 각각 올림 | 오너 Album에서 각각 🍚 Meals · 🐕 Walks · 😴 Naps (샘플 9번 중 8번 맞음 — 틀린 한두 장은 정상) | **👤** (분류) | ➖ |
| CAP-4 | 백엔드를 끄고(또는 `NEBIUS_API_KEY`를 틀리게) 사진 올리기 | **그래도 게시됨**, 캡션이 "… had a lovely moment today 🐾" / "A moment from today's care 🐾", Album에서는 ✨ Moments | 🤖 `caption` · pytest | ➖ |
| CAP-5 | 영상 올리기 | 첫 프레임으로 캡션 · 분류, 카드에 ▶ | **👤** | ➖ |
| CAP-6 | 오너 → Feed → **Timeline / Album** 토글 | Timeline = 최신순 카드. Album = 날짜 헤더("Oct 9, 2026") 아래 분류별 3열, **빈 분류는 안 보임**, "Meals · 2" 같은 개수. 사진을 누르면 뷰어 | 🤖 `caption` | ➖ |
| CAP-7 | 할 일(밥 · 산책 · 낮잠 · 놀이)을 사진과 함께 완료 | 오너 Album에서 그 사진이 할 일 종류대로 Meals · Walks · Naps · Play에 들어감 | **👤** | ➖ |

### 3.13 완료 · 리뷰 · Life Record (DONE) — Phase 07C · *사전: Life Record는 백엔드 + `NEBIUS_API_KEY`, 돌봄이 끝난(Returned) 예약 — 만드는 법은 [test-run.ko.md](test-run.ko.md) §2*

| ID | 단계 | 기대 결과 | 자동 | 상태 |
| :--- | :--- | :--- | :--- | :--- |
| DONE-1 | 시터가 **Returned** | 시터 토스트 "… home safe — Robert gets a notice". 오너 알림 두 개: **"Max and Mochi are home safe 🏠"** → 바로 뒤 **"Thanks for trusting Chloe! How was … stay? ⭐"** (이 순서) | SQL N | ➖ |
| DONE-2 | 오너 → 그 예약 상세 | 맨 위 **"home safe 🏠"** + **Stay summary**(기간 · 알림장 수 · 사진 수 · 완료 할 일 수 · 마지막 알림장 첫 문장 — **그 돌봄 기간만** 셈) | 🤖 `completion` | ➖ |
| DONE-3 | **Leave a review ⭐** → 별 없이 Send | Send **비활성**. 별을 누르면 선택 표시 (마우스 · 키보드) | 🤖 `completion` | ➖ |
| DONE-4 | 별 4 + 코멘트 → **Send review** | 토스트 "Thanks! Chloe was told", 예약 상세로 돌아오고 **별 · 코멘트 읽기 전용**, Leave a review 사라짐. 시터에게 "Robert left you 4 stars ⭐" 알림 | 🤖 `completion` · SQL N | ➖ |
| DONE-5 | 같은 리뷰를 다시 (주소 `/owner/bookings/<id>/review` 직접) | "you already reviewed this stay" — 두 번 못 씀. 돌봄이 안 끝난 예약이면 "Not ready yet" | 🤖 `completion` · SQL N | ➖ |
| DONE-6 | 오너 → Chloe 시터 프로필 | **★ 평균 · 후기 수**, 최근 코멘트(리뷰어는 **이름만**). 후기가 없으면 별점 줄 없음 | 🤖 `completion` | ➖ |
| DONE-7 | 끝난 예약 상세를 처음 엶 (Life Record가 없을 때) | "📖 Writing the Life Record…" → 펫마다 **LifeRecordCard**. 기록 없는 칸(예: 배변을 안 적음)은 **안 보임**, 전부 비면 "Nothing was recorded…". 출처 "From Chloe · Oct 9 – Oct 12" | 🤖 `completion` · pytest · **실제 모델 👤** | ➖ |
| DONE-8 | **지어낸 내용이 없는지** — 이번 돌봄에 없던 것(산책을 안 했는데 "loves long walks", 약 할 일이 없는데 약 얘기)이 기록에 있나? 3번 확인 | 없어야 함 | pytest · **👤 3회** | ➖ |
| DONE-9 | 기록 어디에도 lockbox · buzzer · 주소 · 전화번호 · 이메일이 없나? | 없어야 함 (Heads-up이나 Sitter tips에 섞여 들어가지 않음) | pytest · **👤** | ➖ |
| DONE-10 | AI가 실패하는 상황(백엔드 끔) | "Couldn't write … Life Record" + **Retry**. 백엔드를 켜고 Retry → 기록 생성. 이미 있으면 다시 안 만듦(새로고침해도 요청 없음) | 🤖 `completion` | ➖ |
| DONE-11 | 오너 → 펫(Max) → **📖 Life Record** | 최신 돌봄이 위, **Earlier stays** 아래. 알림 "…'s Life Record is updated 📖"를 누르면 이 화면 | 🤖 `completion` | ➖ |
| DONE-12 | **다음 시터(다른 계정/시터)에게 Max 요청** → 그 시터 화면의 요청 · 예약 상세 | Max 카드에 **"📖 From Max's Life Record"** (접힘, 지난 시터 · 날짜) → 펼치면 기록. 기록 없는 펫(Mochi)에는 없음. 요청이 거절되면 사라짐 | 🤖 `sitter-bookings` · SQL N | ➖ |
| DONE-13 | 오너 → 케어 요청서 **Make a checklist** (기록에 Heads-up이 있는 펫) | 제안된 주의사항에 지난 Heads-up이 **자동으로** 포함 (오너가 쓴 것과 같은 말은 중복 안 됨) | pytest | ➖ |
| DONE-14 | 다른 시터가 Max에 대해 문의받았을 때(07B) 초안의 출처 | 출처 칩에 "From Max's Life Record" | pytest | ➖ |
| DONE-15 | **보안 (실제 DB 👤)**: 돌봄이 끝난 시터(접근 시간 2시간 이후) · 제3자가 기록 조회, 오너가 `source_snapshot` 조회, 클라이언트가 `reviews`에 직접 insert | 모두 0행 / 거부 | SQL N | ➖ |

### 3.14 이번 피드백 반영 (UX)

| ID | 단계 | 기대 결과 | 자동 | 상태 |
| :--- | :--- | :--- | :--- | :--- |
| UX-1 | 오너 → 예약 새로 만들기 → Drop-off / Pick-up **날짜를 탭** | **달력 시트**가 뜸. 오늘 이전 날은 비활성(Pick-up은 Drop-off 이전), 월 이동 가능, 날짜를 누르면 그 날로 선택. −/+ 는 여전히 하루씩 | 🤖 `booking` | ➖ |
| UX-2 | 시터 Home (돌보는 중) | **All tasks / My history**가 숫자 타일과 **달라 보임** (색 테두리 · 연한 배경 · `›`), 누르면 이동 | **👤** (모양) | ➖ |
| UX-3 | 시터 → Bookings 탭 | **진행 중이거나 48시간 안에 시작하는 확정 예약**이 있으면 **Upcoming**으로 열림, 그게 없고 요청이 있으면 **Requests**, 둘 다 없으면 Requests. Requests 개수는 탭에 계속 표시. 직접 고른 탭은 안 덮어씀 | 🤖 `sitter-bookings` | ➖ |
| UX-4 | 오너 → Bookings → **Your questions** | 내 문의가 최신순으로, "Waiting for …" / "💬 Reply ready" / "Booking requested" (= INQ-19) | 🤖 `inquiry` | ➖ |
| UX-5 | 시터 Bookings에 대기 요청 · 답할 문의가 있을 때 (폰 너비 402) | Requests · Questions · Upcoming · Past가 **한 줄**, 숫자는 칸 오른쪽 위 **작은 배지**(괄호 "(1)" 없음) (FB-30) | 🤖 `sitter-bookings` · `inquiry` | ➖ |
| UX-6 | `pets`로 리셋한 오너(예약 · 문의 · 시터 이력 없음) → Bookings 탭 | 빈 화면 대신 **Sitters on Goldito** — 시터 카드(→ 프로필), 아래 Book care. Book care의 시터 목록에도 각 시터 옆 **Profile** (FB-32) | 🤖 `sitters` | 로컬 ✅ 10/09 민식 · Vercel ➖ |

### 3.15 이름 변경 (NAME) — Pawddy → Goldito

| ID | 단계 | 기대 결과 | 자동 | 상태 |
| :--- | :--- | :--- | :--- | :--- |
| NAME-1 | 앱 첫 화면 · 로그인 · 가입 | 어디에도 "Pawddy"가 없고 **Goldito** | 🤖 (iframe 제목) · **👤** | ➖ |
| NAME-2 | 데모 계정으로 로그인 (한 번 로그아웃된 상태에서) | Try the demo 로그인 성공 (이메일 `@goldito.test`) | 🤖 `welcome` | 🟡 10/08 Claude가 브라우저로 두 버튼 로그인 확인 (사람 확인 대기) |
| NAME-3 | 새 사진 업로드 후 Cloudinary 주소 | 폴더 `goldito/…`. **예전 사진(`pawddy/…`)도 계속 보임** | pytest | ➖ |
| NAME-4 | Meet & Greet 영상 링크 · `.ics` 파일 | 제목이 "Goldito Meet & Greet — …", 파일명 `goldito-meet-greet.ics` | **👤** | ➖ |
| NAME-5 | 동의서 문구 | "demo template for the Goldito hackathon" | **👤** | ➖ |

### 3.16 예약 흐름 피드백 (FLOW) — [feedback-2026-10-08.ko.md](feedback-2026-10-08.ko.md) 반영 후 확인할 것 *(FLOW-13~23은 #60에서 수정 · FLOW-1~12는 R2(민식) / R4(슬기)에서)*

| ID | 단계 | 기대 결과 | 자동 | 상태 |
| :--- | :--- | :--- | :--- | :--- |
| FLOW-1 | 오너가 예약 요청 → 시터 화면 (새로고침 없이) | 시터 Home · Bookings가 새로고침 없이 갱신 — Requests 탭 모서리 배지 1, 문의면 Questions (FB-2) | 👤 (실시간) | ❌ 10/08 민식 (실시간 안 뜸) |
| FLOW-2 | 시터가 Accept → 오너 화면 | 오너 예약이 새로고침 없이 Confirmed로 | 👤 (실시간) | ➖ |
| FLOW-3 | 오너 **Finish booking** (시터 요금표가 있는 상태 — **10/08에 Chloe 요금 행을 임시로 넣음**: 보딩 $55 · 추가 펫 +50% · 공휴일 +25%, 다시 눌러 확인) | 체크아웃이 열려 **견적 · 동의서 · 데모 결제**가 진행됨 (FB-7) | 🤖 `checkout` (mock — 요금표 없음 → "hasn't set their prices yet" · 서비스 안 함 → "doesn't offer" 2건 추가) · pytest `test_seed_demo` | ❌ 10/08 민식 ("This sitter doesn't offer that service" — `sitter_rates` 비어 있음). 코드 수정됨 — 호스팅 DB에 `seed_demo` 실행 후 다시 확인 |
| FLOW-4 | 요금표가 **없는** 시터로 체크아웃 | "Chloe hasn't set her prices yet"처럼 **진짜 이유** 문구 (서비스 문구 아님) | 새로 필요 | ➖ |
| FLOW-5 | 시터 Bookings: 드롭오프 끝난 예약 | **In progress** 에만 나옴, Upcoming에 없음 (FB-8) | 새로 필요 | ❌ 10/08 민식 |
| FLOW-6 | 시터 **Returned** | **확인 시트**가 먼저 뜸, 합의된 픽업 2시간 전 이전에는 비활성, 확인한 뒤에만 처리 (FB-9) | 새로 필요 | ❌ 10/08 민식 (바로 처리됨) |
| FLOW-7 | 시간 변경 시트에서 Drop-off 를 바꾸고 Pick-up 탭 → 다시 Drop-off | 각각 고친 값이 **유지** (FB-5) | 새로 필요 | ❌ 10/08 민식 |
| FLOW-8 | 두 탭을 고치고 **Send to …** | 바뀐 것 **전부** 한 번에 저장 · 전송. **Close** 는 아무것도 저장 · 전송하지 않고 그냥 닫힘 | 새로 필요 | ❌ 10/08 민식 |
| FLOW-9 | Received 가 끝난 예약에서 **Change time or place** | 끝난 Drop-off 는 비활성/숨김, 에러("That handoff already happened.")가 안 나옴 (FB-6) | 새로 필요 | ❌ 10/08 민식 |
| FLOW-10 | 모든 날짜 · 시간 입력(Book care · 문의 · 변경 시트 · M&G · 스케줄 · 케어) | 날짜 탭 → 달력, 시간 탭 → 시계, − + 는 하루 / 15분 (DESIGN.md §7.10) (FB-3) | 새로 필요 | ❌ 10/08 민식 (변경 시트는 − + 만) |
| FLOW-11 | 예약 상세 · 카드 (오너) | 시터 이름 옆에 헤더와 같은 **Sitter 알약**, 시터 쪽엔 **Owner** 알약 (FB-4) | 새로 필요 | ❌ 10/08 민식 |
| FLOW-12 | Max → Care tasks → Add → 입력칸 라벨 | 굵은 라벨 + 같은 줄에 **작은 연한 회색 힌트**, 엠대시 없음 (FB-1) | 새로 필요 | ❌ 10/08 민식 |
| FLOW-13 | 오너가 체크아웃에서 Pay 한 직후 예약 화면 | 맨 위에 **확인 카드**: 결제 금액 · 드롭오프 시각 · "Nothing else to do"; **누르면 사라지고** 새로 고침해도 그대로, 상단 칩 줄에 `Paid` (FB-12) | 🤖 `checkout` (Pay 후 카드 · 닫기 · 새로 고침) | ❌ 10/09 민식 (Paid 칩만 있어 저장됐는지 모름) → 코드 수정됨, 다시 확인 |
| FLOW-14 | 예약 화면의 준비물(Pack for …) | 준비물에 체크하고 나갔다 와도(새로 고침) 체크가 남음. "saved on this device" 안내 (FB-13, 이 기기에만 저장 · 시터는 못 봄) | 🤖 `checkout` (체크 → 새로 고침) | ❌ 10/09 민식 (체크가 저장 안 됨) → 코드 수정됨, 다시 확인 |
| FLOW-15 | 시터가 알림장 Send → 오너 Home | **Live updates**에 📓 알림장 카드, 누르면 그 알림장 (FB-21) | 🤖 `live-updates` | ➖ |
| FLOW-16 | 시터 Home → **My history** | 보낸 알림장이 📓 "Daily report · Sent"(본문 두 줄, 누르면 전체)로 보임. 초안은 안 보임 (FB-23) | 🤖 `sitter-home` | ➖ |
| FLOW-17 | Received 뒤 / Returned 뒤 예약 목록 · 상세 (오너 · 시터) | Received 뒤 **In care**, Returned 뒤 **Completed — pets home** (더는 "Confirmed" 아님) (FB-26) | 🤖 `handoff` | ➖ |
| FLOW-18 | Returned 뒤 오너 Home | ⭐ "How was …'s stay?" 카드가 **리뷰를 남길 때까지** 고정(열어 봐도 남음), 리뷰 후 사라짐 (FB-24) | 🤖 `live-updates` | ➖ |
| FLOW-19 | 오너가 리뷰를 남긴 뒤 시터 → 그 예약 상세 | "Robert's review" 카드에 별점 · 코멘트. 리뷰 전이면 "hasn't left a review yet" (FB-29) | 🤖 `handoff` | ➖ |
| FLOW-20 | 오너 리뷰 화면에서 별 5 → 프리셋 칩 / 별 2로 바꿈 | 별점마다 다른 프리셋 3개, 별을 바꾸면 이전 선택이 빠짐. 고른 문구 + 직접 쓴 글이 코멘트로 저장 (FB-27) | 🤖 `completion` | ➖ |
| FLOW-21 | 시터 Returned 뒤 그 예약(또는 Past) → **⭐ Rate Robert** → 별 · 프리셋 · 한마디 → Save | "Your note about Robert" 읽기 전용 + Edit. "🔒 Only you can see this — Robert is never told." 오너에게 알림 **없음**, 오너는 읽을 수 없음 (FB-25) | 🤖 `handoff` · SQL O | ➖ |
| FLOW-22 | 같은 오너가 다시 예약 요청 → 시터가 그 요청 열기 | 맨 위에 "Your notes from earlier stays with Robert"(별 · 메모 · 날짜, 본인만 보임) (FB-29) | 🤖 `handoff` | ➖ |
| FLOW-23 | 오너 리뷰 Send → "Add Chloe to your favorites?" → ⭐ Add | 예약으로 돌아감. Bookings의 Your sitters에 "★ Favorite"·맨 위, Book care 검색에서 ★ 시터가 먼저. 시터 프로필의 ☆/★로 끄고 켬. 이미 즐겨찾기면 묻지 않음 (FB-28) | 🤖 `completion` · SQL P | ➖ |

---

### 3.17 코드 리뷰 수정 (REV) — [review-2026-10-08.ko.md](review-2026-10-08.ko.md) *(RV-6~10은 #60에서 수정 · RV-1~5는 R1b(민식) · M · L은 Phase Q(슬기) — ID는 리뷰 문서 항목과 같음)*

**사전:** main이 Vercel에 배포됨, 원하는 상태로 리셋. "자동" 칸은 고치는 커밋이 채운다.

| ID | 무엇을 | 기대 결과 | 자동 | 상태 |
| :--- | :--- | :--- | :--- | :--- |
| R0-1 | 스택 PR의 CI | `supabase` 잡이 010 · 011을 적용하고 스모크 M · N이 실제로 돈다 | 🤖 CI `supabase` 잡 (#56 초록, 로컬 스모크 423 ✓ — 2026-10-08) | ➖ |
| R0-2 | CI를 토론토 자정 · 저녁 · 월말에 | `care-tasks` · `report` · `booking` · `caption` spec이 시각과 무관하게 통과 | 🤖 고정 시계(`NOON_TORONTO`) · CI `frontend` (#55 · #56 초록, flows 182 ✓ — 2026-10-08) | ➖ |
| RV-1 | 시터가 밤 슬롯을 열지 않았거나 남은 자리 1인데 펫 2마리로 문의 | AI가 "가능"이라고 하지 않고, 안 되는 날을 말함 · 견적 없음 | 새로 필요 | ➖ |
| RV-2 | 막힌 날짜로 문의(자동 발송 켬) | "Yes, I can host" 같은 답이 나가지 않음, 자동 발송 안 되고 시터 확인 대기 | 새로 필요 | ➖ |
| RV-3 | 시터가 Decline 칩 → Send | 오너 화면에 견적 카드 · Request booking이 없음. 토글로 끌 수도 있음 | 새로 필요 | ➖ |
| RV-4 | 예약한 적 없는 오너가 처음 문의 | 시터 Questions 카드 · 스레드에 **오너 이름**과 **펫 이름 · 정보**가 보임 | 새로 필요 | ➖ |
| RV-5 | 오너가 시터 A · B에게 문의 후 A를 예약 / 문의 기간이 지남 | B는 그 펫의 Life Record를 못 읽음, 닫힌 문의에서 Regenerate는 409 | SQL smoke | ➖ |
| RV-6 | Diary에서 메모 · 사진 칩 하나를 끄고 Write | 초안에 꺼진 칩 내용이 없음 | 🤖 `report` (`off` 전송 · 사진 칩 하나만 꺼도 설명 제외) · pytest `test_ai_daily_report` (꺼진 메모 · 피드 원문이 모델 입력에 없음 · 할 일 사진 캡션 제외 · `_ref` 숨김), `test_ai_report_chips` (칩 id = 기록 id) | ➖ |
| RV-7 | 켜진 칩 9개 이상으로 Write | 안내 문구가 보이고 초안이 생김 (422 없음) | 🤖 `report` (안내 문구 · 9개 전송 · 422 문구) · pytest `test_ai_daily_report` (칩 12개 → 앞 8개) | ➖ |
| RV-8 | AI가 꺼진 상태(키 없음)로 Write | "plain list" 안내와 함께 칩 목록 초안 → 고쳐서 Send 가능 | 🤖 `report` (안내 · Send) · pytest `test_ai_daily_report` (장애 · 빈 답 → 목록 초안, 꺼진 칩 없음) | ➖ |
| RV-9 | 시터 Returned 직후 오너가 home safe 알림을 눌러 예약 열기 | 오류 없이 "Writing the Life Record…" → 기록 표시, 기록은 펫마다 하나 | 🤖 `completion` (Returned 직후 대기 · 재진입 시 요청 1번 · 실패해도 기록 있으면 표시) · pytest `test_ai_life_record` (23505 재사용 · 모델 전 재확인) | ➖ |
| RV-10 | 같은 시터와 두 번째 돌봄 후 Life Record | 이번 돌봄의 알림장 내용만 반영 | pytest `test_ai_life_record` (예전 돌봄 제외 · 긴 돌봄은 최신 5개 · 이 예약의 문의 우선 · 끝난 뒤 문의 제외) | ➖ |
| M-1 | 정책이 있는 시터에게 단순 문의 | 에이전트 안 탐(빠름), 응답 35초 이내 | pytest | ➖ |
| M-2~M-3 | "1박에 얼마?" · "Oct 9-14" · "10% off?" 문의 | 틀린 금액 · 날짜 · 할인이 초안에 남지 않음 | pytest | ➖ |
| M-4 | 다른 오너 대화에 전화번호 · 출입 코드가 있었던 시터 | 새 초안 · 프롬프트 예시에 번호 · 코드 없음 | pytest | ➖ |
| M-5 | 백엔드를 끈 채 오너가 문의 → 백엔드 켜고 시터가 스레드 열기 | 시터는 문의 알림을 받았고, 스레드를 열면 초안이 만들어짐 | 새로 필요 | ➖ |
| M-6 | 요금표 없는 시터에게 문의(자동 발송 켬) | 자동 발송 안 됨, 시터에게 "가격 없음" 확인 요청 | pytest | ➖ |
| M-7 | Write it myself로 쓰는 중 초안 도착 | 쓰던 글 유지 + "A draft is ready" 배너 | 새로 필요 | ➖ |
| M-9 | "Somewhere else" + 메모로 문의 → Request booking | 시터 · AI가 메모를 보고, 예약 프리필에 메모가 있음 | 새로 필요 | ➖ |
| M-10 | "Are you real?" 문의 | 시터 확인 대기(자동 발송 안 됨), "virtual Meet & Greet" 초안은 통과 | pytest | ➖ |
| M-11 | 시터가 Regenerate 3번 | 시터 알림은 처음 한 번뿐 | SQL smoke | ➖ |
| M-12 | Diary를 열어 두고 다른 탭에서 체크인 후 돌아오기 | 새 칩이 보이고, 꺼 둔 칩은 꺼진 채 | 새로 필요 | ➖ |
| M-13 | 사진 추가 직후 바로 삭제 | 삭제한 사진의 칩이 다시 나타나지 않음 | 새로 필요 | ➖ |
| M-14 | "Missed a medication" 칩 | 끌 수 없고, 오너 알림장 상세에 놓친 약이 보임 | 새로 필요 | ➖ |
| M-15 | 시간 변경이 합의된 예약에서 알림장 | 새 시각 기준으로 하루 기록이 잡힘 | pytest | ➖ |
| M-16 | 초안 생성 중 다른 창에서 Send | 보낸 알림장이 초안으로 돌아가지 않음 | pytest | ➖ |
| M-17 | 식사 체크인에 사진 첨부 → 오너 Album | 사진이 🍚 Meals에 | SQL smoke · 새로 필요 | ➖ |
| M-18 | 캡션이 오래 걸림(느린 모델) | 12초 뒤 기본 캡션으로 게시 | 새로 필요 | ➖ |
| M-19 | 인사 · 맺음말이 있는 말투 카드의 시터가 사진 올림 | 캡션에 "Hello …" · "Kind regards" 없음 | pytest | ➖ |
| M-20~M-21 | 메모에 전화번호 · 게이트 코드, 약 할 일 없음 | Life Record에 번호 · 코드 · 지어낸 약 없음, 오너의 "산책 금지" 주의는 남음 | pytest | ➖ |
| M-22 | 옛 예약을 열어 기록을 쓴 뒤 다음 시터 요청 | "From Max's Life Record"가 가장 최근 돌봄 기준 | pytest | ➖ |
| M-23 | 모델이 빈 답 | 빈 기록 대신 이전 Heads-up을 이어받음, 알림 없음 | pytest | ➖ |
| M-24 | `seed_demo.py --check` (이름이 다른 DB) | 이름 차이를 알려 줌, `--apply`로 고쳐짐 | 수동 | ➖ |

---

## 4. 알려진 제약 (버그로 올리기 전에 확인)

- **오너 Diary 탭은 시터가 보낸 알림장만 보여 준다** — 실시간 소식(Live)은 Home, 전체 기록은 History. Diary 안의 Live 섹션은 아직 없다 (TODO의 IA follow-up).
- **문의 AI**: Render가 잠들어 있으면 첫 답장이 30~50초 더 걸린다. 자동 발송 지연(약 30초)은 임시 공식이다(슬기 확정 전). 오너는 Bookings 탭의 "Your questions"에서 지난 문의로 다시 들어갈 수 있다.
- **문의 AI의 가능 여부 = 예약 엔진의 규칙 (RV-1):** 펫 수만큼 자리가 없는 슬롯이나 시터가 안 연 날이 하나라도 있으면 "못 해요"다. 호스팅 DB에 **`011c`가 적용되기 전에는** 이 검사를 못 해서 모든 답장이 "확인해서 알려 드릴게요"(가격 없음, 자동 발송 안 됨)로 나온다.
- **후속 질문의 AI 답 (FB-34, 알려진 한계):** 모델은 최신 오너 메시지 + 앞선 대화(최대 6개)를 읽지만, **날짜 · 견적 · 가능 여부는 문의에 저장된 원래 일정** 기준이다. 그래서 "Could you open for me?" 같은 후속에도 "그날은 자리가 없다"로 답할 수 있다 — 시터가 일정을 열거나 직접 쓰는 것이 맞는 경우다(오너가 일정을 열어 달라는 요청이면 시터 확인이 필요하다고 표시하는 프롬프트는 Q.4b / RV-2 몫).
- **Change dates와 011j · 011k:** 오너의 Change dates는 `011j`, 시터의 Decline · Suggest(can_host=false, 견적 없음)는 `011k`가 호스팅 DB에 적용돼 있어야 한다(없으면 "Couldn't change the dates / send the reply"). 새 앱은 옛 DB에서 답장 전송이 실패하고, 옛 앱(Vercel main)은 011k 뒤에도 그대로 동작한다(`p_outcome`은 선택). 시터의 **Suggest** 메시지는 일반 글이라 오너가 "이 날짜로 바꾸기" 한 번에 쓰는 버튼은 아직 없다(Change dates로 직접 고름).
- **문의 이어 쓰기 (FB-34):** 오너의 **Write back** 칸은 *시터의 답이 마지막 메시지일 때만* 보이고(내가 보낸 뒤에는 시터가 답할 때까지 숨김), 문의가 `booked` · `closed`면 없다. 새 초안은 백엔드가 "마지막 초안 이후의 새 오너 메시지"로 만든다 — Render가 잠들어 있거나 모델이 실패하면 초안이 늦거나 없고, 시터는 **Write it myself**로 직접 답할 수 있다. **Change dates**는 새 문의를 만들 뿐 이전 문의는 닫지 않는다. 장소가 *Somewhere else*였던 문의는 메모를 저장하지 않아서 시트에서 장소 메모를 다시 써야 한다.
- **일찍 Received한 뒤의 기록 (CW-1, 2026-10-09 수정):** 체크인 · 할 일 · 알림장 칩 · 초안이 모두 "약속된 드롭오프와 Received 중 **이른 쪽**"부터 센다(끝은 약속된 픽업 그대로). 체크인 · 할 일 쪽은 DB 함수라 **`011i`가 호스팅 DB에 적용돼야** 바뀐다 — 적용 전에는 `in_care` 리셋 뒤 3분 동안 체크인이 "Tasks open once the stay has started"로 막힌다(알림장 칩은 백엔드 배포만으로 고쳐짐).
- History는 **읽기 전용**이다. 시터 Diary(알림장 쓰기)는 7.3에서 생겼다(스택 #55).
- Heads-up은 시터 **예약 상세와 Home**에 보인다. "도착 카드"(Pet Transit)는 Phase 06B에서 만든다.
- History는 3가지 기록(할 일 · 체크인 · 피드 사진)을 화면에서 합쳐 보여준다. 같은 사진이 Feed에도 있으면 한 번만 나온다.
- 체크인은 **전송 후 취소할 수 없다** (연타 잠금만 있음). 필요해지면 "10초 취소"를 추가한다.
- 알림을 지워도 History에는 남는다 (알림 = 지우는 것, 기록 = 남는 것).
- AI 기능: 문의 응대(07B) · 알림장(07) · 캡션(09) · Life Record(07C)는 main에 머지됐다(#55~#58, 수정 #60). 안전 검사(08)는 아직이다. 알려진 문제는 [review-2026-10-08.ko.md](review-2026-10-08.ko.md).
- 샘플 사진 트레이는 **데스크톱 프레임 / 데모 계정**에서만 보인다. 실제 폰 + 일반 계정에서는 **Take photo / Choose from library**.
- 사진 · 영상 업로드와 피드 삭제는 **백엔드가 떠 있어야** 한다.
- 안 읽은 알림 숫자는 벨이 있는 화면에서만 보인다 (Welcome · 로그인 화면 제외).
- 데모 예약의 **픽업 시각이 지나면** 시터 화면의 할 일 · 체크인이 막힌다 (1.3).
- 이름 변경(2026-10-06) 뒤 첫 접속에서는 로그인 세션 저장 키가 바뀌어 **한 번 로그아웃**되고, 할 일 알림 미루기(snooze)도 처음 상태로 돌아간다. 새 사진 · 영상은 Cloudinary `goldito/` 폴더로 가고(2026-10-07 Goldito 이름 변경부터), 예전 `pawddy/` · `pawnote/` 사진도 그대로 보인다.

---

## 5. 버그 · 요청

- **버그**: GitHub 이슈로 올린다 (제목 · 본문은 영문, [CLAUDE.md](../../CLAUDE.md) 규칙). 최소한 **시나리오 ID · 계정 · 한 일 · 기대 · 실제 · 스크린샷** 을 적는다.
- **시나리오 추가 요청**: 아래 표에 한 줄 적어서 개발자에게 알린다. 확인되면 위 3장으로 옮긴다.

| 날짜 | 요청한 사람 | 기능 | 역할 | 이런 기대 결과를 확인하고 싶다 | 처리 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 10/04 | 민식 | 오너 Care tasks | 오너 | 시간을 +로만 올리지 않고 직접 눌러 고르기. 등록한 태스크를 눌러 상세 보기 · 수정 | ✅ 구현됨 (06 후속) |
| 10/04 | 민식 | 시터 Mark done | 시터 | Mark done → 팝업(메모 입력 + Done)에서 한 번 더 Done 하면 전송 | ✅ 구현됨 (06 후속) |
| 10/04 | 민식 | 시터 전송 반응성 | 시터 | 눌린 것/전송된 것/알림 갔는지가 분명해야 함, 연타 시 동작, 내가 보낸 기록(히스토리) | ✅ 구현됨 (06 후속) |
| 10/04 | 민식 | 알림 삭제 | 오너·시터 | 밀어서 지우기(60% 이상) · Clear all | ✅ 구현됨 (06 후속) |
| 10/04 | 민식 | 시터 Home | 시터 | 스크롤 없이 한눈에 보이는 대시보드, 나머지는 버튼으로 들어가서 | ✅ 구현됨 (06 후속) |
| 10/04 | 민식 | Diary 재정의 | 오너 | Diary에는 시터가 쓴 일기만. 시시각각 업데이트는 Home에 알림처럼, 지울 수 있고, 나중에 다시 볼 수 있게 | ✅ 구현됨 (06 후속) |
| | | | | | |

---

## 6. 갱신 규칙

1. Task 하나를 끝내는 커밋에서 **2장 현황표**의 줄 상태와 **3장 시나리오**(필요하면 새 ID)를 같이 고친다.
2. 자동 테스트를 추가했으면 "자동" 열에 스펙 이름을 적고, **자동으로 못 보는 것**(실제 폰 · 실시간 · 디자인)은 👤로 남긴다.
3. 사람이 확인했으면 상태에 `✅ 10/05 민식` 처럼 날짜와 이름을 적는다. 실패하면 ❌와 이슈 링크.
4. 새 제약이 생기면 4장에 한 줄 추가한다.
