# 개발 인계 — 2026-11-04

## 목표와 현재 범위

절전되는 로컬 PC 대신 항상 실행되는 원격 Linux 머신에서 서비스를 운영하고 개발을 이어갑니다. 전체 목적은 여러 업체의 식당 예약·웨이팅 신청과 접수 시각 실행을 통합하는 것입니다. 캐치테이블은 **예약 화면 준비 + 같은 서버 브라우저의 원격 인계**, 시럽프렌즈 나니요리는 **다음날 신청 + 지정 시각 자동 제출·결과 수집**까지 구현했습니다. 캐치테이블 최종 예약 확정·결제와 공급자 취소는 아직 자동화하지 않았습니다.

전체 목적과 구조는 README/AGENTS에 두고, 업체별 세부 동작은 [캐치테이블](CATCHTABLE.md), [나니요리](SYRUP_WAITING.md)에 기록합니다.

## 구현된 것

| 영역 | 현재 동작 |
| --- | --- |
| 런타임 | Node 26.13.0, native TypeScript, Playwright 1.64.1. Docker의 Linux Chromium은 headed로 실행 |
| 인증 | 네이버 기본, 카카오 지원. SOPS 자격 증명으로 한 번 입력 후 CAPTCHA·추가 인증은 사람이 완료 |
| 세션 | 같은 Chrome 프로필 재사용. 유효하지 않으면 SOPS로 저장한 cookies/localStorage/IndexedDB/sessionStorage 복원 시도. 계정 식별자 불일치는 차단 |
| 원격 화면 | Xvfb + Openbox + x11vnc + noVNC. PC/휴대폰 브라우저에서 서버 Chrome을 직접 조작 |
| 접근 링크 | 1회용 fragment 토큰 → 명시적 버튼 클릭 → HttpOnly/SameSite 쿠키. HTTPS에서 Secure. 로그인 viewer와 관리 화면 권한 분리 |
| 목록 | 모수 서울, 노뜨르, 베수비오 3곳. 매장 추가·수정, 셰프 검색, 휴점 보류 |
| 요청 | 방문 날짜·시간·인원과 실행 시각을 별도 저장. 초안은 실행하지 않고 명시적으로 실행 등록해야 함 |
| 스케줄러 | 1초 간격, 실행 2분 전부터 로그인 확인, 실행 시각 이후 매장 페이지에 방문 날짜 쿼리 전달. 최종 시간·인원 선택은 사람이 확인 |
| 중복 방지 | 하나의 계정·브라우저를 직렬 사용. 겹치는 10분 실행 구간 거부. 원자적 상태 전이. 진행 중 재시작은 내역 확인 상태로 전환 |
| Slack | SOPS의 Incoming Webhook 사용. 요청에서 알림을 선택한 경우 로그인/예약 화면 링크 발송. 알림 실패로 브라우저 동작을 반복하지 않음 |
| 저장 | Node SQLite로 매장·요청 저장. Docker named volume에 DB와 브라우저 상태 유지 |
| 나니요리 | 원본 봇의 입력·확인·최종 제출·결과 추출 이관. 다음날 오전/오후 신청, 실행 전 취소 |
| 시럽 연락처 | 관리 키에서 파생한 키로 AES-GCM 암호화. 마스킹 번호만 API 반환 |
| 시럽 중복 방지 | 날짜·시간대별 활성 요청 1건, 최종 제출 전 SUBMITTING 기록, 결과 불확실 시 UNKNOWN으로 중단 |

아래 예약 준비 흐름과 원격 인계 설명은 캐치테이블에 해당합니다. 시럽의 상태 흐름·인원·연락처·자동 접수는 [나니요리 문서](SYRUP_WAITING.md)를 따릅니다.

실행 흐름은 `DRAFT → SCHEDULED → PREPARING → READY`입니다. 필요하면 `NEEDS_LOGIN`을 거칩니다. `READY`는 예약 화면이 준비됐다는 의미이고, `COMPLETED`는 사용자가 예약 내역 확인을 마쳤다는 의미입니다. 공급자가 검증한 예약 성공 상태는 없습니다. 만료는 `EXPIRED`, 중단·불확실성은 `INTERRUPTED`로 처리하며 자동 재예약하지 않습니다.

매장 페이지를 여는 것만 자동화되어 있습니다. 날짜 쿼리가 실제 선택으로 반영됐는지, 시간·인원·좌석·메뉴가 정확한지는 원격 화면에서 확인해야 합니다. 결제와 취소 조건도 사용자 확인 대상입니다. 접속 종료는 실행 시각으로부터 최대 10분이므로 준비가 지연되면 조작 시간도 짧아집니다.

## 확인한 실제 상태와 남은 사용자 입력

이 항목은 인계 당시의 기록이며 새 머신의 상태를 뜻하지 않습니다.

- 로컬 Docker에서 개인 캐치테이블 계정의 로그인과 프로필 재사용을 확인했습니다. 새 머신·IP에서의 재사용은 미검증입니다.
- Slack Webhook을 SOPS에 등록해 실행 중 서비스에 반영했습니다. 사용자가 허용한 연결 확인 메시지 1회를 전송했고 사용자가 수신을 확인했습니다. 이 허용은 다음 테스트 메시지의 발송 지시가 아닙니다.
- 마지막으로 확인한 운영 DB는 매장 3곳, 예약 요청 0건입니다. 실제 예약·결제를 생성하지 않았습니다.
- 원격 접속 주소는 아직 `http://localhost:4340`입니다. 휴대폰의 Slack 링크 접속에 사용할 HTTPS 주소는 미설정입니다.
- 사용자는 **노뜨르와 베수비오 모두 2026-11-28(토) 저녁**을 목표로 정했습니다. **인원과 허용 가능한 시작 시간대는 아직 답변 전**입니다. 임의로 2명/18시 등을 확정하지 마세요.
- 테스트 예약도 무료 취소가 보장되지 않습니다. 해당 예약 상품의 100% 환불 가능 시각·예약금·노쇼/취소 조건을 확정 전에 확인해야 합니다. 두 매장의 11/28 예약분 취소 수수료표는 아직 확인하지 못했습니다.

### 오픈 일정 — 2026-11-03 캐치테이블에서 확인

| 매장 | 다음 오픈 시각 (KST) | 방문 대상 기간 | 출처 |
| --- | --- | --- | --- |
| 노뜨르 | 2026-11-09 00:00 | 11/16~11/29 | [캐치테이블](https://app.catchtable.co.kr/ct/shop/notre) |
| 베수비오 | 2026-11-10 22:00 | 11/16~11/30 | [캐치테이블](https://app.catchtable.co.kr/ct/shop/vesuvio) |
| 베수비오 다음 차수 | 2026-11-25 22:00 | 12/1~12/15 | 같은 공식 페이지 |
| 모수 서울 | 다음 공식 일시 미확인 | 미확인 | [캐치테이블](https://app.catchtable.co.kr/ct/shop/tempmosuseoul), [공식 홈페이지](https://www.mosuseoul.com/) |

노뜨르 00:00은 **11/8 일요일 밤에서 11/9 월요일로 넘어가는 자정**입니다. 공지는 일회성 확인 결과이며 등록 직전에 다시 확인합니다. 베수비오는 예전 `viatoledo` 주소에서 `vesuvio`로 연결됩니다. 현재 seed의 ID/URL은 기존 `viatoledo`를 유지하고 있어 DB의 실제 ID를 확인한 뒤 작업합니다. 취소나 예약 확정은 이 문서를 읽었다는 이유로 실행하지 않습니다.

## 코드 위치

| 파일 | 역할 |
| --- | --- |
| `src/config.ts`, `src/remote/config.ts` | 앱 URL·제공자, 경로·포트·공개 origin, `.env` |
| `src/sops.ts`, `src/credentials.ts`, `src/session.ts` | 비밀 복호화, 계정 입력 검증, 인증 상태 캡처·암호화 |
| `src/catchtable.ts` | 앱의 실제 init 응답으로 로그인 확인, 소셜 로그인, 추가 인증 감지 |
| `src/remote/worker.ts` | persistent Chrome 및 같은 context의 작업용 탭 |
| `src/remote/coordinator.ts` | 로그인 deduplication, 브라우저 직렬화, 사람에게 원격 인계 |
| `src/remote/grants.ts`, `src/remote/server.ts` | 1회용 권한, 소유자 API, 정적 UI, 인증된 WebSocket→VNC |
| `src/remote/slack.ts`, `src/remote/command.ts` | Slack 발송, 원격 로그인 요청과 관리 링크 CLI |
| `src/app/catalog.ts`, `src/app/store.ts` | 초기 3개 매장, SQLite와 요청 상태 전이 |
| `src/waiting/config.ts`, `src/waiting/store.ts` | 시럽 일정·KST 다음날, 연락처 암호화와 신청 영속화 |
| `src/waiting/syrup.ts`, `src/waiting/scheduler.ts` | 원본 나니요리 접수 흐름, 단건 실행·제출 경계·결과 알림 |
| `public/waiting.*` | 소유자 전용 다음날 웨이팅 신청·내역·실행 전 취소 |
| `src/app/scheduler.ts` | 로그인 사전 확인, 시각에 맞춘 페이지 준비, 만료·인계 |
| `public/app.*`, `public/index.html` | 매장·예약 요청 관리 화면 |
| `public/viewer.*`, `public/style.css` | noVNC viewer와 모바일 입력 |
| `Dockerfile`, `deploy/entrypoint.sh`, `compose.yaml` | 고정 버전 이미지, 가상 화면, persistent volume |
| `deploy/Caddyfile.example` | 같은 머신의 TLS/WebSocket reverse proxy 예제 |

## 개발 및 검증

```sh
nvm install
nvm use
npm ci
npm run browser:install
npm run check
npm test
```

Linux에서 브라우저 시스템 라이브러리가 없으면 `npx playwright install --with-deps chromium`으로 설치합니다. 테스트 브라우저 경로는 `.cache/ms-playwright`입니다. 테스트는 실제 사이트 요청을 fixture로 가로채며 계정·GCP·Slack 비밀이 필요하지 않습니다.

단위·브라우저 테스트는 인증·계정 불일치·CAPTCHA 인계, 세션 복원, 토큰/Origin/WebSocket, SQLite 영속성·중복/겹침 거부·재시작 복구, 시럽의 연락처 암호화·제출 경계·불확실성·결과 검증을 확인합니다.

```sh
docker build -t openrun-remote:local .
docker run --rm --shm-size=1g \
  --mount "type=bind,source=$PWD/tests,target=/app/tests,readonly" \
  openrun-remote:local node tests/integration/remote-desktop.e2e.ts
```

이 통합 테스트는 실제 Chrome·Xvfb·x11vnc·noVNC로 키 입력 전달, 모바일 화면, 관리 화면 일정 등록, 예약 화면 인계·종료, 브라우저 재시작 후 복원을 확인합니다. `tests/integration/waiting.e2e.ts`는 다음날 신청·취소·모의 시럽 접수·대기 번호 표시를 검증합니다. 외부 응답은 모의 처리하며 실제 예약이나 Slack 메시지를 만들지 않습니다. PR CI는 타입 검사·41개 테스트와 두 Docker 통합 테스트를 실행합니다.

## 원격 머신에서 이어갈 순서

1. [원격 실행 문서](REMOTE_MACHINE.md)를 따라 소스·GCP KMS 접근·비공개 설정·HTTPS를 준비합니다.
2. 새 프로필로 로그인하거나 정지 상태의 기존 Docker volume을 비공개로 이관합니다. 로컬과 원격 스케줄러를 동시에 운영하지 않습니다.
3. 새 머신에서 `remote:request`로 확인합니다. 로그인 만료·새 보안 확인이 나오면 원격 링크에서 사람이 완료합니다.
4. HTTPS 공개 origin과 모바일 접속을 확인합니다. Slack 테스트 메시지는 사용자가 다시 명시적으로 지시할 때 한 번 발송합니다.
5. 사용자에게 11/28 인원·시작 시간대와 무료 취소 조건을 확인한 뒤, 두 요청을 실제 오픈 시각으로 등록합니다. 아직 등록된 요청은 없습니다.
6. 캐치테이블 다음 구현은 매장별 인원·시간·메뉴·정책 확인과 공급자 예약 내역/확정 번호 검증입니다. 시럽은 접수 시간의 실제 화면과 정책을 확인하고, 기존 Lambda/EventBridge와 중복 실행되지 않도록 전환한 뒤 사용자가 승인한 신청으로 실검증합니다.

## 알려진 운영 제약

- 단일 프로세스·단일 브라우저 구조입니다. replicas를 늘리거나 여러 VM을 같은 DB/프로필에 연결하는 분산 스케줄러가 아닙니다.
- Playwright/서비스 타이머는 실제 접속 시각을 정확히 보장하지 않습니다. 인증·네트워크·페이지 로딩 지연이 있습니다. 현재 작업은 접속 성능이나 실예약 성공률을 검증한 상태가 아닙니다.
- 캐치테이블의 화면/소셜 로그인 선택자가 바뀔 수 있습니다. 예외는 민감한 Playwright 메시지를 그대로 로그에 출력하지 않도록 처리합니다.
- Chrome 프로필의 SingletonLock에는 hostname이 들어갑니다. 현재 Compose는 `hostname: openrun`으로 고정합니다. 이전 랜덤 hostname의 잠금이 남아 실제 Chrome이 없는데 시작이 막힌 사례가 있었고, 세션을 지우지 않고 잠금 링크만 백업하여 복구했습니다.
- 로그아웃/계정 바꾸기를 통해 이전 계정 식별자와 다르게 되면 `ACCOUNT_MISMATCH`로 중단합니다. 안전 장치를 제거하여 통과시키지 않습니다.
- 비밀은 시작할 때 읽습니다. SOPS 저장은 파일을 원자적으로 교체하므로 bind mount 갱신에는 `docker compose up -d --force-recreate --no-build`가 필요합니다. 원격 작업 중에 실행하지 않습니다.
