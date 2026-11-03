# 상시 원격 머신 실행 및 상태 이관

## 실행 구조와 준비

원격 Linux 머신에서 Docker Compose 서비스 하나를 계속 실행합니다. 브라우저도 그 머신 안에서 실행되며, PC·휴대폰은 화면과 입력을 전달하는 클라이언트입니다. 로컬 PC의 절전 여부는 이관이 완료된 원격 서비스에 영향을 주지 않습니다.

필요한 구성은 Docker Engine/Compose, Node **26.13.0**과 npm, SOPS **3.13.2**, `.sops.yaml`의 GCP KMS 키에 encrypt/decrypt 권한이 있는 Google Application Default Credentials 또는 Workload Identity Federation 설정 파일입니다. 호스트 Node/SOPS는 개발·관리 CLI에 사용합니다. 이미지에는 별도의 Node/SOPS/Chromium과 Xvfb/x11vnc가 포함됩니다.

휴대폰에서 접속하려면 원격 호스트를 가리키는 HTTPS 도메인과 TLS reverse proxy가 필요합니다. 앱 포트는 `127.0.0.1:4340`, VNC는 컨테이너 내부 `127.0.0.1:5900`에만 엽니다. VNC를 인터넷에 공개하지 않습니다.

## 1. 소스와 개발 환경

PR을 병합하기 전에는 작업 브랜치를 clone합니다. 병합 후에는 `main`을 사용합니다.

```sh
git clone --branch feat/remote-machine-handoff https://github.com/yongseongkim/openrun.git
cd openrun
nvm install
nvm use
npm ci
cp .env.example .env
```

`.tools`의 macOS Node 바이너리는 저장소에 포함하지 않습니다. 새 Linux 머신에서 해당 OS/아키텍처의 Node를 설치해야 합니다. SOPS와 Google 인증 도구도 새 머신에서 준비합니다.

## 2. 운영 설정과 KMS 접근

공개 저장소에는 실제 `secrets/catchtable.enc.json`이 없습니다. 다음 중 하나를 선택합니다.

- 기존 설정 유지: 기존 머신의 암호화된 `secrets/catchtable.enc.json`을 승인된 SSH/비공개 경로로 같은 위치에 옮깁니다. 기존 네이버 계정, 관리 키와 Slack Webhook을 그대로 유지할 수 있습니다. 평문으로 복호화해서 옮기지 않습니다.
- 새 설정: KMS 접근을 준비한 뒤 아래 명령으로 만들고 SOPS 편집기에서 계정·Webhook을 입력합니다. `remote:setup`이 비어 있는 관리 키를 생성합니다.

```sh
gcloud auth application-default login
npm run secrets:init
npm run secrets:edit
npm run remote:setup
npm run secrets:check
```

기존 파일을 전달받았다면 `secrets:init`은 실행하지 않고 `remote:setup`부터 사용합니다. 이 명령은 기존 계정·관리 키를 유지하며 `.env`에 호스트 UID/GID를 추가합니다. 저장소의 `.sops.yaml`에는 기존 KMS 키의 리소스 이름만 있고 키 자체와 인증 정보는 없습니다. 다른 KMS 키로 바꾸려면 파일의 SOPS 수신 키와 세션 암호화에 쓰는 creation rule을 함께 검토합니다.

Compose는 기본적으로 `$HOME/.config/gcloud/application_default_credentials.json` 파일 하나를 읽기 전용으로 마운트합니다. 다른 ADC/WIF 파일이면 `.env`에 아래 경로를 지정합니다. 서비스 계정 키 파일을 공개 저장소에 추가하지 않습니다.

```dotenv
OPENRUN_PUBLIC_URL=https://openrun.example.com
# 선택: 존재하는 호스트 측 ADC/WIF 파일의 절대 경로
# OPENRUN_GOOGLE_CREDENTIALS_FILE=/absolute/path/to/credentials.json
# 호스트의 Node/SOPS CLI도 같은 파일을 사용하려는 경우
# GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/credentials.json
```

마운트 경로에는 실제 파일이 있어야 합니다. 컨테이너 실행 UID가 읽을 수 있는지 확인합니다. KMS 접근 확인은 `npm run secrets:check`로 하며, 평문 값은 출력하지 않습니다.

## 3. 이미지 시작과 HTTPS

```sh
docker compose config --quiet
docker compose up -d --build
curl --fail --silent --show-error http://127.0.0.1:4340/healthz
docker compose ps
```

`healthz`는 프로세스가 응답하는지만 확인합니다. 캐치테이블 로그인이나 Slack 전달 성공을 뜻하지 않습니다.

호스트에서 Caddy 등으로 `https://openrun.example.com`을 `127.0.0.1:4340`으로 프록시합니다. `deploy/Caddyfile.example`의 도메인을 실제 주소로 바꾸고 DNS/TLS/WebSocket이 동작하는지 확인합니다. Node의 Origin 검사가 공개 URL과 정확히 일치해야 하므로 터널/프록시의 다른 origin에서 접근하지 않습니다. 호스트에서 접속하는 CLI도 `OPENRUN_PUBLIC_URL`의 주소를 사용합니다.

공개 도메인을 아직 준비하지 않았다면 `http://localhost:4340`을 유지하고 PC에서 SSH 터널로 개발할 수 있습니다. 그 경우 **PC 브라우저의 주소도 `localhost:4340`**이어야 합니다.

```sh
ssh -N -L 4340:127.0.0.1:4340 user@remote-host
```

이 터널은 PC에서만 접근할 수 있는 개발 경로입니다. 휴대폰 Slack의 `localhost` 링크를 원격 머신으로 연결해 주지는 않습니다.

## 4. 로그인과 관리 화면

```sh
npm run remote:request
npm run app:open
```

원격 머신에서 명령을 실행한 뒤 출력된 링크를 본인의 PC/휴대폰에서 엽니다. 새 로그인 확인이 필요할 때만 viewer URL이 출력됩니다. 서버 Chrome에서 CAPTCHA·추가 인증을 직접 완료합니다. PC 브라우저에 로그인 쿠키를 복사하는 방식이 아니며, 사용자는 서버의 브라우저를 원격으로 조작합니다.

관리 링크는 10분 안에 한 번 교환하고 관리 쿠키는 12시간 유지됩니다. 서비스 재시작 시 링크/접속 권한은 새로 발급해야 합니다. DB와 Chrome 상태는 볼륨에 남습니다. 링크를 공개 로그나 이슈·PR에 붙이지 않습니다.

Slack의 실제 발송은 명시적으로 요청한 경우에만 실행합니다. 아래 명령은 **로그인이 필요할 때** 로그인 링크를 보낼 수 있습니다. 이미 로그인된 상태면 발송하지 않으므로 Webhook 연결 확인용 명령으로 사용하지 않습니다.

```sh
npm run remote:request -- --notify
```

예약 화면 준비 알림은 관리 화면의 예약 요청에서 Slack 옵션을 선택했을 때 전송됩니다. 이전 로컬 머신에서 보낸 연결 확인 메시지는 이미 수신 확인됐지만 새 원격 머신에서의 네트워크·공개 링크 동작까지 검증한 것은 아닙니다.

## 5. 기존 데이터 이관

새 프로필로 원격 로그인해 시작해도 됩니다. 기존 로그인과 요청까지 옮기려면 아래 데이터를 이관합니다.

| 위치 | 내용 | Git 포함 여부 |
| --- | --- | --- |
| `secrets/catchtable.enc.json` | 계정·관리 키·Slack Webhook의 SOPS 파일 | 제외, 별도 전달 |
| `.env` | 공개 origin·실행 UID/GID·ADC 파일 경로 | 제외, 새 머신에서 설정 |
| volume `/data/app` | SQLite DB와 WAL/SHM | 제외, 서비스 정지 후 복사 |
| volume `/data/.auth` | SOPS로 암호화된 서버 인증 스냅샷 | 제외, 필요하면 복사 |
| volume `/data/profiles` | 계정별 persistent Chrome 프로필 | 제외, 인증 정보 포함 |
| volume `/data/config`, `/data/cache` | 브라우저 설정·캐시 | 제외 |

원래 디렉터리 이름이 `openrun`이면 볼륨 이름은 보통 `openrun_openrun-data`입니다. 실제 이름은 `docker volume ls`로 확인합니다. 다른 Compose project name을 쓰면 달라집니다. 호스트의 `.auth`는 로컬 CLI 브라우저 상태이고, 운영 서버 스냅샷인 `/data/.auth`와 다릅니다.

이관은 **한 번에 하나의 스케줄러만 실행**하는 방식으로 합니다. 실행 중인 예약/원격 조작이 없는 때 원래 서비스를 정지한 뒤 DB를 복사합니다. 아래 명령은 실제 cutover 때 사용하며 일반 개발 검증 중에는 실행하지 않습니다.

```sh
# 원래 머신에서: 예약/원격 조작 중이 아닌지 확인하고 실행
docker compose stop
```

암호화 계정 파일은 SSH로 별도 전달합니다. 전체 볼륨은 Chrome 인증 정보가 포함되므로 공개 첨부 파일로 만들지 않습니다. 두 머신에 이미지가 준비돼 있고 원격 서비스도 정지돼 있을 때, 다음처럼 SSH 스트림으로 직접 옮길 수 있습니다. 볼륨 이름과 SSH 대상은 실제 환경에 맞춥니다.

```sh
# 원격 머신: 먼저 이미지를 빌드하고 대상 서비스는 시작하지 않은 상태로 준비
docker compose build

# 원래 머신: 정지된 원본 volume → SSH → 원격 volume
docker run --rm --user 0:0 --entrypoint tar \
  --mount type=volume,source=openrun_openrun-data,target=/data,readonly \
  openrun-remote:local -C /data -cf - . | \
ssh user@remote-host 'docker run --rm -i --user 0:0 --entrypoint tar --mount type=volume,source=openrun_openrun-data,target=/data openrun-remote:local -C /data -xf -'
```

이 예제는 전용 머신/볼륨과 Docker 권한이 준비됐다는 전제입니다. UID/GID는 원본 파일 소유자와 원격 Compose 실행 사용자가 맞아야 합니다. 원본의 `.env`에 기록된 UID/GID를 원격에서도 유지하거나, 원격 서비스가 정지된 상태에서 가져온 볼륨의 소유자를 원격 실행 UID/GID로 조정합니다. 라이브 SQLite 파일만 따로 복사하지 않습니다.

이미 다른 데이터가 있는 원격 볼륨에 그대로 덮어쓰지 않습니다. 복구 목적이면 대상 서비스의 상태를 먼저 별도 보존하고 이관 범위를 결정합니다. Google ADC 파일은 이 볼륨에 포함되지 않으므로 새 머신에서 별도로 준비합니다.

원격에서는 이관 후 다음을 확인합니다.

```sh
docker compose up -d --no-build
npm run remote:request
npm run app:open
```

새 머신·IP·아키텍처에서도 인증이 유지되는지는 아직 확인하지 않았습니다. `NEEDS_LOGIN`이나 추가 보안 확인이 나오면 새 머신의 viewer에서 로그인합니다. 상태를 복사했다는 이유로 인증 만료를 우회하지 않습니다. 원격 정상 확인 후에도 로컬 스케줄러는 계속 정지해 둡니다.

## 6. 업데이트와 문제 확인

코드 업데이트는 작업 중인 변경을 먼저 정리한 다음 pull/build합니다. 계정·Webhook·공개 URL 변경은 SOPS로 저장한 뒤 컨테이너를 재생성해야 합니다. 원격 조작 중에는 실행하지 않습니다.

```sh
docker compose up -d --build
# 설정 파일만 변경했고 이미지가 최신인 경우
docker compose up -d --force-recreate --no-build
docker compose logs --tail 30 openrun
```

- `SOPS_FAILED`: 새 머신 ADC/WIF, KMS IAM 권한, 네트워크와 파일 접근을 확인합니다.
- `AUTH_ERROR` / 프로필 사용 중: 동일 프로필을 다른 Chrome/컨테이너가 쓰는지 먼저 확인합니다. Compose의 고정 hostname `openrun`을 유지합니다. 실제 브라우저가 없는 상태에서 이전 hostname의 SingletonLock만 남았다고 검증된 경우에만 잠금 링크를 백업·복구합니다. 프로필이나 `.auth` 전체 삭제로 해결하지 않습니다.
- `ACCOUNT_MISMATCH`: 이전 저장 계정과 다릅니다. 계정 전환 의도와 원본 상태 보존을 확인합니다.
- Slack은 오지만 링크 접속 불가: 공개 origin이 `localhost`인지, 실제 HTTPS 주소·DNS·TLS·WebSocket 프록시가 맞는지 확인합니다.
- 접속 링크 만료: 권한은 메모리에만 있으므로 새 링크를 발급합니다. 이미 준비 중이던 예약의 내역도 먼저 확인합니다.
- 재시작 후 `INTERRUPTED`: 캐치테이블 내역을 확인한 뒤 새 요청 여부를 판단합니다. 서비스 상태를 억지로 `SCHEDULED`로 바꿔 재실행하지 않습니다.

`docker compose down -v`는 운영 DB·프로필·세션을 지울 수 있으므로 서비스 업데이트 명령으로 사용하지 않습니다.
