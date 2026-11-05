import type { Provider } from "./config.ts";
import { decryptJson } from "./sops.ts";
import { AuthError } from "./errors.ts";

export type Credentials = { username: string; password: string };

export function credentialsFrom(values: unknown, provider: Provider): Credentials {
  const data = values as Record<string, unknown> | null;
  const prefix = provider.toUpperCase();
  const username = data?.[`${prefix}_USERNAME`];
  const password = data?.[`${prefix}_PASSWORD`];
  if (typeof username !== "string" || !username.trim() || typeof password !== "string" || !password.trim()) {
    throw new AuthError("CREDENTIALS_MISSING", `${prefix}_USERNAME과 ${prefix}_PASSWORD를 SOPS 파일에 입력해 주세요.`);
  }
  // Passwords must retain their original whitespace.
  return { username: username.trim(), password };
}

export async function loadCredentials(provider: Provider, filename: string): Promise<Credentials> {
  // Also supports the user's existing `sops exec-env` workflow.
  const prefix = provider.toUpperCase();
  if (process.env[`${prefix}_USERNAME`] !== undefined || process.env[`${prefix}_PASSWORD`] !== undefined) {
    return credentialsFrom(process.env, provider);
  }
  return credentialsFrom(await decryptJson(filename), provider);
}
