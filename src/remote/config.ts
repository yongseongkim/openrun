import { resolve } from "node:path";
import { ROOT, parseProvider } from "../config.ts";
import { AuthError } from "../errors.ts";
import { existsSync } from "node:fs";

export function loadLocalEnvironment() {
  const path = resolve(ROOT, ".env");
  if (existsSync(path)) process.loadEnvFile(path);
}

export function publicOrigin(value = "http://localhost:4340"): string {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(local && url.protocol === "http:"))) {
    throw new AuthError("INVALID_CONFIG", "OPENRUN_PUBLIC_URL은 HTTPS 주소 또는 로컬 HTTP 주소로 지정해 주세요.");
  }
  return url.origin;
}

export function remoteConfig(env: NodeJS.ProcessEnv = process.env) {
  const port = Number(env.OPENRUN_PORT ?? "4340");
  const ttlMs = Number(env.OPENRUN_LOGIN_TTL_SECONDS ?? "600") * 1000;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 600_000) {
    throw new AuthError("INVALID_CONFIG", "포트 또는 로그인 대기 시간 설정을 확인해 주세요. 대기 시간은 60~600초입니다.");
  }
  return {
    host: env.OPENRUN_HOST ?? "127.0.0.1", port,
    origin: publicOrigin(env.OPENRUN_PUBLIC_URL), ttlMs,
    provider: parseProvider(env.CATCHTABLE_AUTH_PROVIDER),
    profileDir: resolve(env.OPENRUN_PROFILE_DIR ?? resolve(ROOT, ".profiles")),
    authDir: resolve(env.OPENRUN_SESSION_DIR ?? env.OPENRUN_AUTH_DIR ?? resolve(ROOT, ".auth")),
    channel: env.OPENRUN_BROWSER_CHANNEL ?? (process.platform === "darwin" ? "chrome" : "chromium"),
    vncHost: "127.0.0.1", vncPort: Number(env.OPENRUN_VNC_PORT ?? "5900"),
  };
}

export type RemoteConfig = ReturnType<typeof remoteConfig>;

export function adminToken(values: Record<string, unknown>, env = process.env): string {
  const token = env.OPENRUN_ADMIN_TOKEN ?? values.OPENRUN_ADMIN_TOKEN;
  if (typeof token !== "string" || token.length < 32) {
    throw new AuthError("ADMIN_TOKEN_MISSING", "npm run remote:setup으로 원격 접속 설정을 준비해 주세요.");
  }
  return token;
}
