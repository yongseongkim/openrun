import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const VIEWER_COOKIE = "openrun_viewer";

export function secretEquals(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

export class GrantStore {
  #links = new Map<string, { requestId: string; expiresAt: number }>();
  #sessions = new Map<string, { requestId: string; expiresAt: number }>();
  #clock: () => number;

  constructor(clock = Date.now) { this.#clock = clock; }

  mint(requestId: string, expiresAt: number): string {
    this.prune();
    const token = randomBytes(32).toString("base64url");
    this.#links.set(digest(token), { requestId, expiresAt });
    return token;
  }

  exchange(requestId: string, token: string, sessionExpiresAt?: number): { cookie: string; expiresAt: number } | undefined {
    this.prune();
    const key = digest(token);
    const link = this.#links.get(key);
    if (!link || link.requestId !== requestId || link.expiresAt <= this.#clock()) return undefined;
    this.#links.delete(key);
    // A new device takes over this request; previous remote-control cookies stop working.
    for (const [id, session] of this.#sessions) if (session.requestId === requestId) this.#sessions.delete(id);
    const cookie = randomBytes(32).toString("base64url");
    const session = { ...link, expiresAt: sessionExpiresAt ?? link.expiresAt };
    this.#sessions.set(digest(cookie), session);
    return { cookie, expiresAt: session.expiresAt };
  }

  authenticate(cookie: string | undefined): { requestId: string; expiresAt: number } | undefined {
    if (!cookie) return undefined;
    const session = this.#sessions.get(digest(cookie));
    if (!session || session.expiresAt <= this.#clock()) return undefined;
    return session;
  }

  prune() {
    for (const collection of [this.#links, this.#sessions]) {
      for (const [key, value] of collection) if (value.expiresAt <= this.#clock()) collection.delete(key);
    }
  }
}
