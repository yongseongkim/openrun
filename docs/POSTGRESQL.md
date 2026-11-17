# 시럽 웨이팅 PostgreSQL

운영 시럽 전용 서버(`waiting:serve`)는 `DATABASE_URL`을 필수로 사용합니다. homelab의 `postgres.database.svc.cluster.local:5432`에 `openrun` 전용 DB와 계정을 만드는 구성이 기준입니다. 앱의 DB 파일/PVC는 필요하지 않습니다. 기존 캐치테이블 통합 모드와 명시적인 로컬 모의 테스트는 SQLite 어댑터를 유지합니다. PostgreSQL 연결 실패 시 SQLite로 전환하지 않습니다.

## 저장 구조

| 테이블 | 내용 |
| --- | --- |
| `waiting_requests` | 방문일·AM/PM·인원·암호화 연락처·준비/시도/마감 시각·현재 상태·최근 결과·알림 상태 |
| `waiting_attempts` | 요청별 실행 시작·제출·종료 시각, 상태, 결과와 안전한 메시지 |
| `waiting_schema_migrations` | 적용한 SQL 파일명·SHA-256 checksum·적용 시각 |

방문일은 `date`, 실제 실행 시각은 `timestamptz`입니다. API는 기존처럼 epoch 밀리초와 KST 방문일 문자열을 사용합니다. 활성 신청에 `(restaurant_id, visit_date, slot)` 부분 unique index를 적용합니다. 취소·제출 전 실패·만료된 신청만 같은 슬롯에 새로 신청할 수 있고, `UNKNOWN`/`INTERRUPTED`는 사람이 확인하기 전 중복 신청을 차단합니다.

연락처는 기존 AES-GCM 형식을 그대로 사용합니다. 원문은 DB에 저장하지 않으며 요청 ID를 authenticated data로 사용합니다. `OPENRUN_ADMIN_TOKEN`에서 암호화 키를 파생하므로 DB 이전·백업 복원 시 같은 관리 키를 보존해야 합니다. API에는 마스킹 번호만 반환하고 접속 URL·SQL/드라이버 오류·연락처는 로그에 출력하지 않습니다.

## DB와 역할 준비

실제 공용 DB를 변경하는 단계입니다. 개발 검증이나 테스트 명령은 이 절차를 실행하지 않습니다. homelab 운영자가 PostgreSQL 관리자 연결에서 실행하며, 비밀번호는 `psql`의 `\password` 프롬프트로 지정하고 SOPS/Kubernetes Secret에 보관합니다.

```sql
CREATE ROLE openrun_migrations LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
\password openrun_migrations
CREATE ROLE openrun_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
\password openrun_app
CREATE DATABASE openrun OWNER openrun_migrations;
REVOKE ALL ON DATABASE openrun FROM PUBLIC;
GRANT CONNECT ON DATABASE openrun TO openrun_app;
```

런타임에는 `DATABASE_URL`로 `openrun_app` 연결을 주고, 마이그레이션 Job/명령에만 DDL 역할의 `WAITING_MIGRATION_DATABASE_URL`을 제공합니다. 별도 migration URL이 없으면 명령은 `DATABASE_URL`을 사용합니다. 접속 문자열에 특수 문자가 들어간 사용자/비밀번호는 URL 인코딩합니다. 서버에 직접 연결하거나 session pooling을 사용합니다. 실행권은 세션 advisory lock이므로 transaction pooling을 사용하는 연결에는 붙이지 않습니다.

## 스키마 적용과 실행

환경 변수 또는 SOPS 파일의 같은 이름 키를 사용합니다. 실제 URL은 `.env`, Kubernetes Secret 또는 암호화된 설정에만 둡니다. `.env.example`, `secrets/catchtable.example.json`은 빈 값/자리표시자 예제입니다.

```sh
# DB 소유자/마이그레이션 역할로 실행
npm run waiting:db:migrate
```

버전 SQL은 `src/waiting/migrations/`에 있습니다. 마이그레이션은 전용 transaction advisory lock으로 직렬화하고, 파일 적용과 버전 기록을 같은 트랜잭션으로 커밋합니다. 재실행은 안전하며 이미 적용한 파일의 checksum이 바뀌면 거부합니다. 배포 후 변경은 기존 파일 수정 대신 새 번호 SQL을 추가합니다.

최초 적용 후 DB 소유자가 `openrun` DB에서 런타임 권한을 부여합니다. 새 테이블이 생기는 후속 migration에서도 필요한 권한을 추가합니다.

```sql
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO openrun_app;
GRANT SELECT ON waiting_schema_migrations TO openrun_app;
GRANT SELECT, INSERT, UPDATE ON waiting_requests, waiting_attempts TO openrun_app;
```

이후 런타임의 `DATABASE_URL`로 기동합니다.

```sh
npm run waiting:serve
npm run waiting:open
```

앱은 시작할 때 migration 파일과 DB 적용 내역을 검증합니다. 스키마가 없거나 일치하지 않으면 `WAITING_SCHEMA_REQUIRED`로 시작을 거부합니다. 앱이 운영 계정으로 DDL을 자동 실행하지 않습니다.

Compose에서는 이미지 빌드 → migration → 실행 순서를 사용합니다. SOPS의 migration URL을 사용하거나 별도 연결 정보를 일회성 명령에 전달합니다.

```sh
docker compose -f compose.waiting.yaml build
docker compose -f compose.waiting.yaml run --rm --no-deps waiting npm run waiting:db:migrate
docker compose -f compose.waiting.yaml up -d --no-build
```

## 실행권과 복구

처음에는 스케줄러 Pod 1개와 `Recreate` 배포 전략을 사용합니다. DB 연결 한 개를 스케줄러 전용으로 잡고 session advisory lock을 획득한 프로세스만 복구·실행 상태를 변경합니다. 두 번째 서버는 `WAITING_SCHEDULER_BUSY`로 시작을 거부하며 다른 서버의 진행 중인 작업을 복구하지 않습니다.

`RUNNING` 전환과 attempt 생성은 같은 트랜잭션입니다. `SUBMITTING` 전환과 제출 시각 기록도 같은 전용 세션의 트랜잭션으로 완료한 뒤 브라우저가 최종 클릭합니다. 기록이 실패하면 클릭하지 않습니다. 실행권 연결을 잃으면 서비스와 브라우저를 종료하고 그 프로세스에서 다시 실행권을 얻지 않습니다. 새 프로세스가 실행권을 얻은 뒤 `RUNNING → INTERRUPTED`, `SUBMITTING → UNKNOWN`으로 복구하며 재제출하지 않습니다.

Slack 전송과 알림 상태 기록은 접수 결과와 분리합니다. 알림 저장 실패로 성공 상태를 되돌리거나 시럽에 다시 제출하지 않습니다. 외부 시럽 접수와 DB 커밋은 하나의 분산 트랜잭션이 아니므로 결과가 불확실하면 내역을 사람이 확인해야 합니다.

## 백업·이관과 테스트

PostgreSQL 백업은 homelab의 기존 `pg_dump → OCI Object Storage` 운영 패턴에 맞춥니다. DB 백업과 암호화 관리 키를 함께 복구할 수 있어야 합니다. 백업 복원 직후에는 스케줄러를 정지한 상태에서 이미 실행된 신청을 확인한 후 재개합니다. 이 변경은 운영 PostgreSQL 생성·기존 SQLite 데이터 이관·Lambda 중지를 자동으로 하지 않습니다. 기존 SQLite 볼륨은 별도로 보존합니다.

```sh
npm run check
npm test
npm run test:postgres
```

`test:postgres`는 localhost의 임시 PostgreSQL 18 컨테이너와 임시 스키마/DB를 직접 생성·정리합니다. 실제 homelab DB를 사용하지 않습니다. 동시 중복 신청, 암호화·KST 시각, migration, 상태/이력 트랜잭션, 제출 경계 실패, 실행권 연결 종료와 복구를 검사한 뒤 실제 웹·서버 재시작 통합 테스트도 실행합니다. 시럽 응답은 모의 처리하며 실제 접수와 Slack 전송은 하지 않습니다.

빌드한 Linux 이미지로 같은 검증을 실행할 수도 있습니다.

```sh
docker build --target waiting -t openrun-waiting:test .
OPENRUN_POSTGRES_TEST_IMAGE=openrun-waiting:test npm run test:postgres
```
