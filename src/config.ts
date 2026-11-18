import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { AuthError } from "./errors.ts";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const APP_ORIGIN = "https://app.catchtable.co.kr";
export const INIT_URL = "https://ct-api.catchtable.co.kr/api/v3/init";
export type Provider = "naver" | "kakao";

export function parseProvider(value: string = "naver"): Provider {
  if (value === "naver" || value === "kakao") return value;
  throw new AuthError("INVALID_CONFIG", "로그인 방식은 naver 또는 kakao로 지정해 주세요.");
}

export function parseTimeout(value: string = "180"): number {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) {
    throw new AuthError("INVALID_CONFIG", "--timeout은 1~600초로 지정해 주세요.");
  }
  return seconds * 1000;
}

export function sessionPath(provider: Provider): string {
  return resolve(ROOT, ".auth", `catchtable.${provider}.enc.json`);
}

export function secretsPath(path?: string): string {
  return resolve(path ?? process.env.OPENRUN_SECRETS_FILE ?? resolve(ROOT, "secrets/catchtable.enc.json"));
}
