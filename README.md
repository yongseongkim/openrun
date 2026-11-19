# OpenRun

OpenRun은 **지인끼리 식당 예약과 웨이팅 명부를 작성하면, 접수 시각에 원격 서버가 실행하는 서비스**입니다. 한 페이지에서 가게 탭을 고르고 신청하며, 함께 갈 사람이 늘면 기존 신청자와 연락한 뒤 인원을 수정합니다.

서비스는 항상 켜져 있는 원격 머신에서 실행합니다. PC·휴대폰은 신청 관리와 필요한 인증을 담당하고, 실행 시각에 사용자의 로컬 PC가 켜져 있을 필요는 없습니다.

현재 우선 배포 구성은 **OCI k3s의 나니요리 시럽 웨이팅 + 기존 homelab 공용 PostgreSQL의 전용 `openrun` DB**입니다. 이를 위한 앱 코드는 구현했으며 운영 DB 생성·Helm/ArgoCD 연결·실제 배포 전환은 별도 작업입니다. 서비스가 항상 실행되어 있어도 명부에 저장한 신청만 접수하고, 매일 자동으로 다시 신청하지 않습니다.

## 전체 흐름

1. 접속 링크로 OpenRun(`/`)을 열고 가게 탭을 고릅니다. 지인들의 접속 세션은 동시에 유지됩니다.
2. 나니요리는 인원수·전화번호를 입력합니다. 같은 번호로 다시 신청하거나 명부의 인원을 수정하면 기존 신청을 갱신합니다. 캐치테이블은 방문 일정과 예약 화면을 준비할 시각을 등록합니다.
3. 서버가 한국 시간으로 접수 시각을 정하고 신청을 DB에 저장합니다. 브라우저를 닫아도 신청은 남습니다.
4. 원격 스케줄러가 해당 시각에 실행합니다. 시럽은 웨이팅을 제출하고, 캐치테이블은 인증된 서버 브라우저를 준비해 사람에게 넘깁니다.
5. 실행 결과는 DB에 기록합니다. 캐치테이블의 준비·인계는 웹에서 확인하며, 시럽 화면은 내일의 명부를 보여줍니다. Slack은 명시적으로 알림을 선택한 요청에만 사용합니다.

## 시스템 개요

한 Node 서비스가 웹·API를 제공하고, 같은 프로세스에서 업체별 스케줄러와 브라우저 자동화 코드를 실행합니다. Chromium은 서비스가 띄우는 별도 브라우저 프로세스입니다. 별도의 작업 큐나 Lambda 호출 없이 스케줄러가 DB의 실행 대기 신청을 확인합니다. 웹 화면은 단순한 명부와 신청 관리에 집중하고, 실행 중복 방지와 복구 기록은 서버가 관리합니다.

아래 두 실행 모드는 같은 웹과 업체별 코드를 재사용합니다. 우선 배포 모드는 시럽 전용이며, 기존 통합 모드의 DB를 PostgreSQL과 자동으로 합치지 않습니다.

| 실행 모드 | 제공하는 가게 탭 | 저장소와 브라우저 | 실행 구성 |
| --- | --- | --- | --- |
| 시럽 전용 · 우선 배포 | 나니요리 | PostgreSQL, 접수용 headless Chromium. 앱 데이터 볼륨·캐치테이블 계정 불필요 | `waiting:serve`, Docker target `waiting`, `compose.waiting.yaml` |
| 기존 통합 모드 | 나니요리 + 등록한 캐치테이블 매장 | 로컬 SQLite, 별도 시럽 context, 지속 Chrome 프로필과 원격 데스크톱 볼륨 | `remote:serve`, Docker target `remote`, `compose.yaml` |

```mermaid
flowchart LR
  User["지인들의 PC · 휴대폰"] --> Web["OpenRun 한 페이지 · 가게 탭"]
  Web --> API["공유 관리 인증 · API"]
  subgraph Waiting["시럽 전용 모드 · 우선 배포"]
    PG[("PostgreSQL · 명부와 실행 이력")]
    WS["시럽 스케줄러"] --> Syrup["격리된 Chromium · 웨이팅 제출"]
    PG --> WS
    Syrup --> PG
  end
  subgraph Combined["기존 통합 모드"]
    SQLite[("SQLite · 예약 요청과 시럽 명부")]
    CS["캐치테이블 스케줄러"] --> Chrome["인증된 지속 Chrome"]
    Chrome --> Viewer["noVNC · 사람이 예약 확정"]
    SQLite --> CS
    Viewer --> SQLite
    SQLite --> LegacySyrup["시럽 스케줄러 · 별도 context"]
    LegacySyrup --> SQLite
  end
  API --> PG
  API --> SQLite
  Secrets["SOPS · GCP KMS 또는 환경 변수 · Secret"] --> API
  WS -.-> Slack["명시적으로 선택한 Slack 알림"]
  CS -.-> Slack
```

두 박스는 배포 모드의 선택지입니다. 하나의 통합 프로세스가 PostgreSQL과 SQLite를 동시에 묶어 운영하는 구조는 아닙니다.

## 업체별 현재 기능

| 업체 | 신청 내용 | 현재 실행 범위 |
| --- | --- | --- |
| 캐치테이블 | 매장, 방문 날짜·시간·인원, 예약을 준비할 시각 | 로그인·세션 재사용 → 매장 페이지 준비 → 원격 화면 인계. 시간·인원 최종 선택과 예약 확정·결제는 사용자 진행 |
| 시럽프렌즈 · 나니요리 | 내일 오전 10시 명부의 인원수·전화번호 | 2분 전 브라우저 준비 → 정각 1초 뒤 인원·전화번호 입력 → 확인 → 최종 제출 → 결과 저장 |

캐치테이블 초기 목록은 **모수 서울·노뜨르·베수비오**입니다. 접속 주소는 `/` 하나이며 활성화된 가게를 탭으로 표시합니다. 캐치테이블 매장을 추가하면 같은 화면에 새 탭이 생깁니다. 기존 `/waiting` 링크도 이 페이지로 연결됩니다.

나니요리 탭에는 **내일 오전 10시 명부**만 표시합니다. 인원수·전화번호를 입력하고, 같은 번호로 다시 신청하면 기존 인원수가 바뀝니다. 각 행의 **인원 수정**으로도 바로 바꿀 수 있습니다. 함께 가고 싶다면 기존 신청자에게 연락한 뒤 수정하는 방식입니다. 명부를 함께 쓰는 여러 관리 세션이 동시에 유지됩니다.

날짜·시간·상태를 별도로 고르지 않습니다. 휴무 예정일에는 다음 영업일로 넘기지 않고 내일의 휴무를 안내합니다. 매장 설정은 `src/waiting/config.ts`에서 관리하며 현재 휴무 예정일은 **월·목**입니다. 새 신청은 **09:58에 준비하고 10:00:01부터 시도**합니다. 이 설정은 최신 매장 정책을 보장하지 않으므로 운영 변경은 확인 후 반영합니다. 실행 흐름은 기존 [bots-on-lambda/syrupWaitingForNaniyori](https://github.com/yongseongkim/bots-on-lambda/tree/main/syrupWaitingForNaniyori)에서 이관했습니다.

## 시스템 구성

| 구성 요소 | 역할 |
| --- | --- |
| 웹 · API | 한 페이지의 가게 탭, 공유 접속 인증, 명부 저장·인원 수정·삭제, 캐치테이블 요청 관리 |
| PostgreSQL | 시럽 전용 모드의 `waiting_requests`·`waiting_attempts`·migration 내역. 암호화한 연락처와 실행 기록 저장 |
| SQLite | 기존 통합 모드의 캐치테이블 요청·시럽 명부, 명시적인 로컬 모의 테스트 저장소 |
| 업체별 스케줄러 | 접수 시각 판단, 실행 준비, 만료·중단·불확실한 결과 처리 |
| 캐치테이블 실행기 | 하나의 계정·지속 프로필을 직렬 사용하고 필요하면 noVNC로 사람에게 인계 |
| 시럽 실행기 | 로그인 없는 별도 브라우저 context에서 나니요리 접수. 최종 제출 직전 상태를 기록 |
| Slack | 사용자가 선택한 신청의 로그인 필요·예약 준비·웨이팅 실행 결과 알림 |
| SOPS · GCP KMS | 계정·관리 키·Webhook·캐치테이블 인증 스냅샷 암호화 |
| Docker · k3s | 시럽 전용 서비스와 공용 PostgreSQL 연결. 통합 모드는 Xvfb·x11vnc와 지속 데이터 볼륨도 사용 |

Node **26.13.0**, native TypeScript, Playwright를 사용합니다. 운영 시럽 데이터는 `DATABASE_URL`이 가리키는 PostgreSQL에 저장하고 앱 Pod는 데이터 볼륨 없이 교체할 수 있습니다. 신청과 실행 이력은 별도 테이블에 기록하며 최종 제출 직전 상태까지 트랜잭션으로 저장합니다. 전용 DB 세션의 advisory lock으로 스케줄러와 복구 실행을 하나로 제한합니다. 통합 모드의 기존 SQLite·캐치테이블 프로필·인증 상태는 `openrun-data`에 남습니다. AWS Parameter Store나 EventBridge를 사용하지 않습니다.

같은 전화번호의 명부 저장은 기존 행을 갱신하고, 인원 수정과 실행 시작은 DB 잠금으로 조정합니다. 실행기는 실행 권한을 얻을 때 읽은 최종 인원수를 사용합니다. 실행권 연결을 잃으면 서비스를 중단하고, 제출 여부가 불확실한 신청은 자동으로 다시 보내지 않습니다. PostgreSQL에 연결하지 못해도 로컬 SQLite로 전환하지 않습니다.

웨이팅 전화번호는 SOPS 또는 환경 변수에서 제공한 관리 키로 파생한 키를 사용해 AES-GCM으로 암호화합니다. 화면과 API에는 마스킹한 번호만 표시합니다. DB를 이관·복원할 때 같은 관리 키도 필요합니다. 관리 링크와 접속 쿠키는 메모리에 있어 서버 재시작 후 새 링크가 필요하며, DB의 신청과 실행 이력은 유지됩니다.

## 코드 구조

| 위치 | 역할 |
| --- | --- |
| `public/index.html`, `public/console.js` | 공통 페이지, 가게 탭, 관리 접속 |
| `public/waiting.js`, `public/app.js` | 나니요리 명부와 캐치테이블 요청 패널 |
| `src/remote/` | HTTP·인증·원격 브라우저 인계·Slack. 통합 모드 진입점 |
| `src/waiting/` | 내일 접수 계산, 연락처 암호화, 저장소·migration, 시럽 실행기와 스케줄러. 시럽 전용 진입점 |
| `src/app/` | 캐치테이블 매장 목록·SQLite 요청 저장·예약 준비 스케줄러 |
| `src/catchtable.ts`, `src/session.ts` | 캐치테이블 인증 확인·로그인·인증 상태 저장과 복원 |

설치와 운영 전환은 [원격 실행 문서](docs/REMOTE_MACHINE.md), DB 역할·migration·백업은 [PostgreSQL 문서](docs/POSTGRESQL.md), 실제 검증 이력과 남은 작업은 [개발 인계](docs/DEVELOPMENT_HANDOFF.md)에 기록합니다.

## 실행

나니요리만 OCI에서 운영할 때는 PostgreSQL DB/계정과 `DATABASE_URL`, 관리 키를 먼저 준비합니다. 환경 변수/Kubernetes Secret 또는 기존 SOPS/GCP KMS 파일을 사용합니다. 네이버·카카오 계정은 필요하지 않습니다. [PostgreSQL 설정과 마이그레이션](docs/POSTGRESQL.md), [OCI 시럽 전용 실행 안내](docs/REMOTE_MACHINE.md#oci에서-나니요리만-실행)를 따릅니다.

```sh
docker compose -f compose.waiting.yaml build
docker compose -f compose.waiting.yaml run --rm --no-deps waiting npm run waiting:db:migrate
docker compose -f compose.waiting.yaml up -d --no-build
docker compose -f compose.waiting.yaml exec -T waiting npm run waiting:open
```

아래는 캐치테이블까지 함께 실행하는 통합 구성입니다.

Node/SOPS, Docker Compose, GCP KMS 접근을 준비한 뒤 실행합니다. 실제 비밀 파일은 공개 저장소에 포함하지 않습니다.

```sh
nvm install
nvm use
npm ci
npm run secrets:init
npm run secrets:edit
npm run remote:setup
docker compose up -d --build
npm run app:open
```

기존 SOPS 파일을 전달받았다면 `secrets:init`은 생략합니다. 관리 링크를 열고 **OpenRun 열기**를 누른 뒤 가게 탭을 고릅니다. 외부 PC·휴대폰 접속은 HTTPS 공개 주소가 필요하며, 설치·설정·이관 순서는 [원격 머신 실행 문서](docs/REMOTE_MACHINE.md)를 따릅니다.

## 상태와 실행 원칙

- 캐치테이블의 `READY`는 화면 준비, `COMPLETED`는 사용자의 내역 확인 완료입니다. 공급자가 확인한 예약 성공으로 해석하지 않습니다.
- 시럽의 `SUCCEEDED`는 완료 화면에서 대기 번호를 읽은 상태입니다. 최종 제출 후 결과를 잃으면 `UNKNOWN`으로 남기고 자동 재시도하지 않습니다.
- 신청 취소는 아직 실행하지 않은 서버 요청을 취소합니다. 이미 공급자에 등록된 예약·웨이팅을 취소하는 기능은 별도로 구현해야 합니다.
- CAPTCHA·추가 인증은 사람이 처리합니다. 실제 접수 조건·예약금·환불/노쇼 규정은 실행 전에 확인합니다.
- 서비스 정지·재시작·네트워크 지연이 있을 수 있어 접수 시각과 성공을 보장하지 않습니다. 여러 머신에서 같은 요청을 동시에 실행하지 않습니다.

## 개발과 문서

```sh
npm run browser:install
npm run check
npm test
npm run test:postgres
```

테스트는 모의 업체 응답을 사용합니다. 실제 계정·전화 수신자·예약·결제·Slack을 대상으로 검증하지 않습니다. GitHub Actions CI는 사용하지 않으며, 타입 검사·단위 테스트와 Docker 통합 테스트는 개발 환경에서 직접 실행합니다. 통합 테스트 실행 방법은 [개발 인계 문서](docs/DEVELOPMENT_HANDOFF.md#개발-및-검증)를 참고합니다.

- [개발 지침과 전체 구조](AGENTS.md)
- [PostgreSQL·DB 계정·마이그레이션·테스트](docs/POSTGRESQL.md)
- [캐치테이블 로그인·예약 준비](docs/CATCHTABLE.md)
- [나니요리 이관·내일 접수 명부](docs/SYRUP_WAITING.md)
- [원격 실행·설정·상태 이관](docs/REMOTE_MACHINE.md)
- [구현 상태와 미정 작업 인계](docs/DEVELOPMENT_HANDOFF.md)

다음 확장 대상은 업체별 접수 조건·결과 검증을 공통 흐름에 추가하고, 명시적으로 승인한 조건 안에서 예약 자동화 범위를 넓히는 것입니다. 구체적인 진행 상황과 날짜가 정해진 테스트 계획은 인계 문서에 기록합니다.
