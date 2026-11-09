# 캐치테이블 로그인과 예약 준비

캐치테이블 서버 로그인, 매장 목록, 방문 일정과 예약 준비 시각을 관리합니다. 계정 정보와 로그인 세션은 SOPS와 GCP KMS로 암호화합니다. 지정 시각에 로그인된 서버 브라우저에서 매장을 열고, 사용자가 원격 화면에서 예약을 확정하는 보조 예약 방식입니다. **현재 자동 최종 예약 제출·결제 기능은 없습니다.**

- 원격 머신에서 이어가기: [개발 인계](DEVELOPMENT_HANDOFF.md), [원격 머신 실행·이관](REMOTE_MACHINE.md)
- 실행 구조: 상시 실행 Docker Compose 서비스 1개 + SQLite + 같은 계정의 지속 Chrome 프로필
- 공개 저장소에는 코드·예제 설정을 저장합니다. 실제 `secrets/catchtable.enc.json`, `.env`, 인증 상태와 브라우저 프로필은 별도로 전달해야 합니다.

## 매장과 예약 요청

```sh
docker compose up -d --build
npm run app:open
```

출력한 1회용 관리 링크를 열고 **나의 목록 열기**를 누릅니다. 링크는 10분 동안 교환할 수 있고 관리 접속은 12시간 유지됩니다. 원격 로그인 링크에는 목록 수정 권한이 없습니다. 서버를 재시작하면 새 관리 링크가 필요합니다.

2026-11-02에 각 캐치테이블 페이지를 확인한 초기 목록입니다. 오픈 안내는 확인 당시의 일회성 공지이며 반복 예약 규칙으로 해석하지 않습니다.

| 매장 | 셰프 | 확인한 상태 |
| --- | --- | --- |
| [모수 서울](https://app.catchtable.co.kr/ct/shop/tempmosuseoul) | 안성재 | 운영 |
| [노뜨르](https://app.catchtable.co.kr/ct/shop/notre) | 윤남노 | 운영. 11/9 00:00에 11/16~29 예약 오픈 안내 |
| [베수비오](https://app.catchtable.co.kr/ct/shop/viatoledo) | 권성준 | 기존 비아톨레도 주소의 현재 매장명 |

**매장 추가**에서 캐치테이블 매장 URL, 셰프, 지역, 요청 인원 상한, 오픈 안내와 방문 조건을 저장합니다. 인원 상한은 이 서비스의 입력 제한이며 실제 좌석 가능 여부를 뜻하지 않습니다. 휴점 매장은 예약 요청을 만들 수 없습니다.

**예약 요청**에는 방문 날짜·시간·인원과 **예약을 준비할 시각**을 별도로 입력합니다. 모든 화면 시각은 한국 시간이고 API의 `opensAt`은 시간대가 포함된 ISO 문자열입니다. **초안 저장**은 실행하지 않고 **실행 등록**을 눌러야 예약 준비를 시작합니다. 단일 계정의 브라우저를 공유하므로 10분 실행 구간이 겹치는 요청은 등록할 수 없습니다.

실행 10분 전부터 로그인 상태를 확인하고, 지정 시각 이후 매장 페이지를 방문 날짜의 `date` 쿼리와 함께 엽니다. 인원과 방문 시간은 원격 화면에 표시하며, 사용자가 캐치테이블에서 실제 선택 결과를 확인합니다. **서버 예약 화면 열기**로 접속하여 날짜·시간·인원과 메뉴·주류·결제·노쇼·취소 조건을 직접 확인하고 예약합니다. 접속 종료 시각은 실행 시각으로부터 최대 10분이며, 페이지 준비나 로그인 지연만큼 실제 조작 가능 시간은 짧아집니다. 프로그램이 확정·결제 버튼을 클릭하지 않습니다.

요청에서 **Slack 알림 받기**를 선택하면 설정된 Webhook으로 필요한 로그인 링크와 준비된 예약 화면 링크를 보냅니다. 기본값은 선택 해제입니다. Webhook이 없거나 전송에 실패하면 관리 화면에서 접속합니다. 전송 실패 때문에 브라우저 작업을 재실행하지 않습니다. 로컬 주소를 담은 링크는 서비스를 실행한 PC에서만 사용할 수 있습니다. 휴대폰 접속은 아래 HTTPS 설정이 필요합니다.

`DRAFT → SCHEDULED → PREPARING → READY`로 진행하고 로그인 확인이 필요하면 `NEEDS_LOGIN`입니다. 캐치테이블 내역을 확인하고 원격 화면을 닫으면 `COMPLETED`로 기록합니다. 이는 **사용자의 내역 확인 완료**이며 공급자가 검증한 예약 성공 상태가 아닙니다. 원격 화면을 연 상태에서 서버·연결이 중단되면 `INTERRUPTED`로 남기고 자동 재시도하지 않습니다. 시간이 지나면 `EXPIRED`입니다. 다시 등록하기 전 캐치테이블 예약 내역을 확인합니다. **실행 취소**는 이 서비스의 요청만 취소하며 실제 식당 예약은 취소하지 않습니다.

목록과 요청은 Node SQLite로 `/data/app/openrun.sqlite`에 저장하고 Chrome 프로필과 함께 `openrun-data` 볼륨에 유지합니다. 직접 실행 시 `.runtime/openrun.sqlite`이며 `OPENRUN_DATA_DIR`로 변경합니다. 한 서버 프로세스를 계속 실행하는 구성이며 서버가 꺼져 있거나 인증이 지연되면 정확한 오픈 시각 접속을 보장하지 않습니다. 재시작 시 이미 사람에게 전달했던 요청은 재실행하지 않습니다.

## 실제 매장 흐름 확인 — 2026-11-09

사용자가 요청한 [에다마메 남영점](https://app.catchtable.co.kr/ct/shop/edamame)에서 확정 전 화면을 확인했습니다. 화면 확인용 조건은 **2026-11-11 17:00, 2명**이며 실제 방문 예약 요청으로 등록한 조건은 아닙니다. 별도 테스트 브라우저를 사용했고 최종 제출·결제 버튼은 누르지 않았습니다. 운영 스케줄러·매장 목록·DB는 변경하지 않았습니다.

macOS의 별도 headed Chrome에서 기존 SOPS 세션을 메모리로 복원하고, 캐치테이블 init 응답의 로그인 여부와 저장된 계정 식별자의 일치를 확인했습니다. 현재 앱의 `prepareRestaurant()`를 실제 매장에 실행한 뒤 날짜·인원·시간 선택과 예약서 진입을 추가로 조작했습니다. 이 추가 조작은 테스트용이며 앱의 예약 스케줄러에는 아직 연결하지 않았습니다.

| 단계 | 실제 화면에서 확인한 동작 |
| --- | --- |
| 매장 준비 | `date=261111`로 열기. `예약하기` 버튼 대기 후 날짜·인원 선택 창 열기 |
| 인원 | `getByRole('radio', { name: '2명', exact: true })`로 선택 |
| 시간 | `getByRole('button', { name: '오후 5:00', exact: true })`로 선택 |
| 예약금 방식 | `예약금 결제 방법 선택` dialog. 방식 선택 후 그 dialog 안의 `다음`으로 이동. 별도의 0원 결제 안내 팝업이 동작을 가릴 수 있음 |
| 예약서 | `/ct/reservation/form`에서 날짜·시간·인원 요약이 선택과 일치하고, 로그인 안내 대신 기존 로그인 상태가 유지됨을 확인 |
| 확정 경계 | 예약·결제 관련 버튼 텍스트를 확인했으나 최종 버튼의 고유 선택자와 제출 결과는 검증하지 않음 |

확인 당시 일반 예약금은 1인 10,000원으로, 2명 합계는 20,000원이었습니다. 0원 결제 선택지는 카드 등록과 취소·노쇼 수수료 조건이 있어 무료 취소로 해석하면 안 됩니다. 예약서에는 이용 시간 100분, 대기 손님이 있을 때의 시간 제한, 디너 음료 주문에 관한 필수 확인 항목이 있었습니다. 이 조건은 해당 시점·선택의 관찰 결과이며 다른 매장에 적용하지 않습니다.

예약서 진입만으로도 임시 좌석 찜이 시작됩니다. 비로그인·0원 선택 화면에서는 6분 안내를 확인했습니다. 비로그인 화면은 `닫기`로 매장에 돌아와 시간 버튼이 다시 활성화된 것을 확인했습니다. 로그인 후 테스트에서는 예약서 닫기와 매장 복귀를 자동으로 확인하지 못해 테스트 브라우저를 종료했습니다. 이후 같은 계정의 방문예정 화면(`/ct/mydining/my/planned`)을 로딩한 뒤 에다마메 예약이 표시되지 않는 것을 확인했습니다. 임시 찜이 즉시 해제되었는지는 검증하지 않았습니다. 반복 진입은 좌석에 영향을 줄 수 있으므로 일상 테스트는 모의 응답으로 수행하고, 실제 화면 확인에서는 종료·찜 해제까지 검증해야 합니다.

같은 암호화 세션을 별도 Docker headless Chromium에서 확인할 때는 `ct-api.catchtable.co.kr` 요청의 `net::ERR_FAILED`로 init 응답을 받지 못했습니다. 네트워크 권한을 달리해 재확인해도 같았습니다. 이는 계정 로그아웃으로 판정한 결과가 아니며 원인은 아직 확인하지 못했습니다. **로컬 Chrome의 성공을 원격 Linux 환경의 예약 성공으로 해석하지 않습니다.** 매장별 선택 로직을 운영에 연결하기 전에 Linux의 인증 API 연결, 로그인 후 최종 버튼과 종료 동작, 확정 이후 예약 내역 검증을 별도로 확인해야 합니다.

## 준비

Node.js **26.13.0**, Google Chrome, SOPS, GCP KMS 키를 사용할 수 있는 Google Application Default Credentials가 필요합니다. `.sops.yaml`은 기존 프로젝트와 같은 `homelab-secrets/sops-key` 키를 사용합니다.

원격 운영 환경은 호스트의 Google Chrome 대신 Docker 이미지 안의 headed Chromium·Xvfb·x11vnc를 사용합니다. 호스트 Chrome은 로컬 로그인 명령에서만 필요합니다.

```sh
# nvm을 사용하는 경우
nvm install
nvm use

npm ci
npm run browser:install
npm run doctor
```

이 작업 공간에는 확인한 Node.js 바이너리를 `.tools/node-v26.13.0-darwin-arm64`에 준비했습니다. 현재 터미널에서 사용하려면 다음을 실행합니다.

```sh
export PATH="$PWD/.tools/node-v26.13.0-darwin-arm64/bin:$PATH"
```

GCP 로컬 인증이 아직 없다면 `gcloud auth application-default login`으로 설정합니다. 해당 계정에는 `.sops.yaml`에 지정한 KMS 키의 암호화·복호화 권한이 필요합니다. 기존 SOPS 설정으로 이미 동작한다면 같은 인증을 사용합니다.

## 계정 입력

```sh
npm run secrets:init
npm run secrets:edit
```

SOPS 편집기에서 `NAVER_USERNAME`, `NAVER_PASSWORD`를 입력하고 저장합니다. `KAKAO_*`는 비워 두어도 됩니다. 기본 로그인 제공자는 네이버입니다. 계정 파일은 `secrets/catchtable.enc.json`입니다.

`npm run secrets:check`은 실제 복호화를 수행하고 계정 입력 여부만 출력합니다. 계정 값은 출력하지 않습니다.

다른 SOPS JSON/YAML 파일에 같은 키가 들어 있다면 기존 파일을 사용할 수 있습니다.

```sh
npm run auth:login -- --secrets /absolute/path/to/existing.enc.yaml
```

`OPENRUN_SECRETS_FILE`로 경로를 지정하거나 기존 `sops exec-env` 환경에서 실행할 수도 있습니다. 로그인 제공자는 `--provider naver|kakao` 또는 `CATCHTABLE_AUTH_PROVIDER`로 선택합니다.

## 로그인과 세션 확인

```sh
# 실제 공개 로그인 화면과 입력 필드 점검. 계정 정보를 제출하지 않습니다.
npm run auth:probe

# 네이버 아이디/비밀번호를 자동 입력하고 로그인합니다.
npm run auth:login

# 저장한 세션을 새 브라우저에서 복원해 서버 로그인 상태를 확인합니다.
npm run auth:status
```

네이버에서 CAPTCHA가 표시되면 열린 Chrome 창에서 보안 문자를 직접 입력하고 로그인 버튼을 누릅니다. 프로그램은 완료를 기다린 뒤 캐치테이블 로그인 상태를 확인하여 세션을 저장합니다. 입력할 시간이 더 필요하면 다음과 같이 10분 동안 기다리도록 실행합니다.

```sh
npm run auth:login -- --timeout 600
```

브라우저 명령은 설치된 Google Chrome 창에서 실행합니다. 추가 인증·동의가 나오면 최대 180초 동안 완료를 기다립니다. `--timeout 300`으로 대기 시간을 조정할 수 있습니다. 카카오 로그인을 사용할 경우 `--provider kakao`를 추가합니다. 번들 Chromium을 쓰려면 `--channel chromium`을 지정합니다. 무인 실행은 `--headless`로 하며 추가 인증이 필요하면 `NEEDS_AUTH_APPROVAL`을 반환합니다. 실제 사이트에서 Chromium headless의 API 접근이 차단되는 현상이 있어, 로컬 기본값은 로그인 화면 점검을 통과한 일반 Chrome입니다.

캐치테이블 앱의 `/api/v3/init` 응답에서 실제 로그인과 계정 식별자를 확인한 뒤 `.auth/catchtable.naver.enc.json`에 세션을 SOPS로 암호화하여 저장합니다. 쿠키, localStorage, IndexedDB와 캐치테이블 sessionStorage를 복원합니다. 다음 로그인은 유효한 세션을 우선 재사용합니다.

기존 세션의 계정 식별자가 다르면 `ACCOUNT_MISMATCH`로 중단하고 덮어쓰지 않습니다. 의도적으로 다른 계정으로 바꿀 때는 해당 `.auth` 파일을 별도로 옮긴 뒤 로그인합니다. `--expected-account`로 기대하는 캐치테이블 계정 식별자를 명시할 수도 있습니다.

| 상태 | 의미 |
| --- | --- |
| `LOGIN_FORM_READY` | 실제 로그인 화면과 입력 필드 확인 완료 |
| `AUTHENTICATED` | 캐치테이블 서버에서 로그인 확인 완료 |
| `NEEDS_LOGIN` | 저장된 세션이 없거나 만료됨 |
| `NEEDS_AUTH_APPROVAL` | 추가 인증·동의 또는 수동 확인 필요 |
| `LOGIN_REJECTED` | 계정 정보가 거부됨 |
| `ACCOUNT_MISMATCH` | 이전 세션과 다른 캐치테이블 계정 |
| `AUTH_CHECK_UNAVAILABLE` | 서버 응답·네트워크 문제로 로그인 여부 확인 불가 |
| `SOPS_FAILED` | GCP 인증, KMS 권한 또는 암호화 설정 확인 필요 |

로그에는 비밀번호, 토큰, 로그인 화면 내용, 인증 응답 원문을 남기지 않습니다. `.auth`, 브라우저 캐시와 평문 비밀 파일은 Git에서 제외합니다. 실제 계정 정보는 SOPS 편집기에서 입력합니다.

## 검증

```sh
npm run check
npm test
```

브라우저 테스트는 모의 OAuth 팝업과 모의 캐치테이블 응답을 사용하며 실제 계정에 로그인하지 않습니다. 실제 서버 로그인과 프로필 재사용은 확인했습니다. Lambda에서의 세션 재사용은 별도 검증 대상이며 현재 서비스는 상시 실행 컨테이너 구성입니다.

참고: [Playwright 인증 상태](https://playwright.dev/docs/auth), [SOPS](https://getsops.io/docs/), [네이버 2단계 인증](https://help.naver.com/service/5640/category/4151?lang=ko).

## 원격 브라우저 로그인

Docker 안에서 실행되는 Chrome 화면을 PC·휴대폰 브라우저로 조작합니다. 네이버·캐치테이블의 쿠키는 서버에 저장됩니다. 클라이언트는 noVNC로 화면과 입력을 전달하며, 로그인 확인이 끝나면 조작 연결을 닫습니다. Chrome과 프로필은 다음 작업을 위해 유지합니다.

```sh
# 기존 계정 정보를 유지하고 관리 키를 생성합니다. .env에 로컬 UID/GID도 설정합니다.
npm run remote:setup

docker compose up -d --build

# 저장된 서버 세션을 확인합니다. 재인증이 필요할 때만 접속 URL을 출력합니다.
npm run remote:request

# 재인증이 필요한 경우 Slack으로도 링크를 보냅니다.
npm run remote:request -- --notify
```

로컬 주소는 `http://localhost:4340`입니다. `remote:request`가 출력한 `loginUrl`을 열고 **서버 브라우저 열기**를 누릅니다. 보안 문자·추가 인증은 열린 서버 브라우저에서 직접 완료합니다. 휴대폰에서는 **키보드**, **Tab**, **Enter**, **화면 확대** 버튼을 사용할 수 있습니다. 입력 내용은 화면을 제공하는 서버 Chrome으로 전달됩니다.

유효한 세션이면 `AUTHENTICATED`로 끝나며 새 네이버 로그인이나 Slack 알림을 만들지 않습니다. 세션이 없으면 SOPS 계정으로 한 번 로그인을 시도하고 추가 확인을 기다립니다. 같은 시간의 요청은 하나로 합쳐 반복 로그인을 막습니다. 기본 접속 시간은 10분입니다.

### Slack과 외부 접속

`npm run secrets:edit`에서 `SLACK_WEBHOOK_URL`을 입력합니다. 본인 전용 채널 또는 DM으로 연결된 Incoming Webhook을 사용합니다. 실제 Slack 발송은 `--notify`, 관리 API의 `notify: true`, 또는 예약 요청의 Slack 알림 선택을 명시한 경우에만 실행합니다. 알림 실패는 로그인 상태와 분리하며 비밀번호 재제출을 일으키지 않습니다.

휴대폰에서 외부 접속하려면 서버의 HTTPS 도메인을 준비하고 `.env`에 다음 값을 추가합니다. `localhost`는 링크를 여는 기기 자신을 뜻하므로 외부 접속 주소로 사용할 수 없습니다.

```dotenv
OPENRUN_PUBLIC_URL=https://openrun.example.com
# 선택: ADC 대신 Workload Identity Federation 설정 파일을 마운트할 수 있습니다.
# OPENRUN_GOOGLE_CREDENTIALS_FILE=/absolute/path/to/google-credentials.json
```

`deploy/Caddyfile.example`을 참고해 HTTPS와 WebSocket을 같은 서버의 `127.0.0.1:4340`으로 프록시합니다. Docker는 기본적으로 이 HTTP 포트만 호스트 루프백에 공개합니다. VNC 포트 5900은 컨테이너 내부 루프백에만 바인딩합니다. 운영 서버는 GCP Workload Identity Federation 설정과 KMS 권한을 준비하면 같은 SOPS 파일을 사용할 수 있습니다. 로컬 Compose는 기존 Google ADC 파일 하나를 읽기 전용으로 마운트합니다.

계정·Webhook·외부 주소를 변경한 뒤에는 다음 명령으로 컨테이너를 재생성합니다. 설정은 시작할 때 읽으며, 프로필과 세션이 저장된 `openrun-data` 볼륨은 유지됩니다.

```sh
docker compose up -d --force-recreate --no-build
```

접속 링크는 요청 한 건에 한정된 접근 권한입니다. 1회용 토큰을 URL fragment에 두며 일반 서버 로그·링크 미리보기 요청에는 전송하지 않습니다. 사용자가 버튼을 눌러야 토큰이 소모되고, 이후 HttpOnly·SameSite 쿠키로 WebSocket을 인증합니다. HTTPS에서는 Secure 쿠키를 사용합니다. 링크가 전달되면 다른 사람이 사용할 수 있으므로 본인 전용 채널로 전달해야 합니다. 별도 Slack OIDC 로그인은 포함하지 않습니다.

### 서버 세션과 후속 자동화

`openrun-data` 볼륨에 계정별 Chrome 프로필과 `.auth` 암호화 세션을 보관합니다. 프로그램이 재시작되면 프로필을 우선 확인하고, 세션 쿠키가 사라진 경우 암호화된 스냅샷을 복원합니다. 만료된 쿠키의 수명을 임의로 늘리지는 않습니다. Chrome 프로필은 브라우저가 관리하는 파일이므로 운영 서버에서는 볼륨 암호화와 접근 권한을 적용합니다. SOPS는 세션 스냅샷과 계정 설정을 암호화합니다.

향후 예약 어댑터는 서버의 `AuthCoordinator.withAuthenticatedPage()`로 같은 Chrome context에 작업용 탭을 열 수 있습니다. 사람이 로그인하는 동안에는 자동화 접근을 차단하며, 인증 후 서버가 확인한 계정 식별자가 일치해야 실행합니다. 예약 준비 스케줄러도 같은 context를 사용합니다. 최종 확정은 사용자에게 원격 인계하며 무인 예약 제출은 포함하지 않습니다.

관리 API는 `Authorization: Bearer <OPENRUN_ADMIN_TOKEN>`을 요구합니다.

| 요청 | 역할 |
| --- | --- |
| `POST /api/auth/ensure` `{ "notify": true }` | 세션 확인, 필요한 경우 로그인 시작 및 Slack 알림 |
| `GET /api/auth/requests/:id` | 로그인 진행 상태 조회 |
| `GET /healthz` | 프로세스 상태 확인 |

`OPENRUN_ADMIN_TOKEN`은 `remote:setup`이 SOPS 파일에 생성합니다. 관리 키·계정·쿠키는 서버 로그나 프런트엔드 응답에 포함하지 않습니다. `remote:request`의 URL 출력은 사용자에게 전달하기 위한 명시적인 관리 명령이므로 해당 터미널 출력도 비공개로 취급합니다.

### 원격 환경 검증

기본 `npm test`는 링크 재사용·만료, Origin 검사, WebSocket 인증과 조작 종료, 알림 실패 독립성을 검사합니다. `tests/integration/remote-desktop.e2e.ts`는 Docker 안에서 실제 Chrome·Xvfb·x11vnc·noVNC를 사용하여 웹 입력 전달, 모바일 레이아웃, 동일 브라우저로 자동화 재개, Chrome 재시작 후 세션 복원을 확인합니다. 식당·네이버 요청은 모의 응답으로 제한하고 실제 계정과 Slack에는 접근하지 않습니다.

이미지를 빌드한 뒤 다음처럼 실행할 수 있습니다.

```sh
docker run --rm --shm-size=1g \
  --mount "type=bind,source=$PWD/tests,target=/app/tests,readonly" \
  openrun-remote:local node tests/integration/remote-desktop.e2e.ts
```
