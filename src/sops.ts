import { spawn } from "node:child_process";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AuthError } from "./errors.ts";
import { ROOT } from "./config.ts";

export async function runSops(args: string[], input?: string): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn("sops", args, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) child.kill("SIGTERM");
      else chunks.push(chunk);
    });
    // Errors from secret tools are deliberately not copied to logs.
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.once("error", () => {
      clearTimeout(timer);
      reject(new AuthError("SOPS_UNAVAILABLE", "sops 실행 파일을 찾을 수 없습니다. SOPS를 설치해 주세요."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || size > 16 * 1024 * 1024) {
        reject(new AuthError("SOPS_FAILED", "SOPS 작업에 실패했습니다. GCP 인증, KMS 키 권한, .sops.yaml 설정을 확인해 주세요."));
      } else resolveOutput(Buffer.concat(chunks).toString("utf8"));
    });
    child.stdin.end(input);
  });
}

export async function exists(filename: string): Promise<boolean> {
  try { await access(filename); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function decryptJson(filename: string): Promise<unknown> {
  if (!await exists(filename)) {
    throw new AuthError("SECRETS_NOT_FOUND", "암호화 파일이 없습니다. npm run secrets:init 후 npm run secrets:edit으로 계정을 입력해 주세요.");
  }
  const output = await runSops(["decrypt", "--output-type", "json", filename]);
  try { return JSON.parse(output); }
  catch { throw new AuthError("INVALID_SECRETS", "복호화한 파일을 JSON으로 읽을 수 없습니다."); }
}

export async function encryptJson(filename: string, value: unknown, overwrite = true): Promise<void> {
  const encrypted = await runSops([
    "--config", resolve(ROOT, ".sops.yaml"), "encrypt", "--input-type", "json", "--output-type", "json",
    "--filename-override", filename,
  ], JSON.stringify(value));
  let document: Record<string, unknown>;
  try { document = JSON.parse(encrypted); }
  catch { throw new AuthError("SOPS_FAILED", "SOPS 암호화 결과를 확인하지 못했습니다."); }
  if (!document.sops) throw new AuthError("SOPS_FAILED", "SOPS 메타데이터가 없는 결과는 저장하지 않습니다.");

  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  if (!overwrite) {
    try { await writeFile(filename, encrypted, { mode: 0o600, flag: "wx" }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new AuthError("SECRETS_ALREADY_EXIST", "이미 계정 파일이 있습니다. npm run secrets:edit으로 수정해 주세요.");
      }
      throw error;
    }
    return;
  }
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, encrypted, { mode: 0o600, flag: "wx" });
    await rename(temporary, filename);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function initializeSecrets(filename: string): Promise<void> {
  if (await exists(filename)) {
    throw new AuthError("SECRETS_ALREADY_EXIST", "이미 계정 파일이 있습니다. npm run secrets:edit으로 수정해 주세요.");
  }
  const template = JSON.parse(await readFile(resolve(ROOT, "secrets/catchtable.example.json"), "utf8"));
  await encryptJson(filename, template, false);
}
