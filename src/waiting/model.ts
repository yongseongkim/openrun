import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { AppError } from "../app/store.ts";
import { NANIYORI, nextWaitingOpening, WAITING_TIMING } from "./config.ts";
import type { waitingCatalog } from "./config.ts";
import type { WaitingSlot } from "./config.ts";

export type WaitingState = "SCHEDULED" | "RUNNING" | "SUBMITTING" | "SUCCEEDED" | "UNKNOWN" | "FAILED" | "EXPIRED" | "CANCELLED" | "INTERRUPTED";
export type WaitingResult = { waitNumber: string; teamsAhead: string; registrationTime: string };
export type WaitingJob = {
  id: string; restaurantId: string; visitDate: string; slot: WaitingSlot; partySize: number;
  phoneMasked: string; opensAt: number; prepareAt: number; runsAt: number; deadline: number; state: WaitingState; notify: boolean;
  createdAt: number; updatedAt: number; result?: WaitingResult; message?: string; notification?: "SENT" | "FAILED";
};
export type PrivateWaitingJob = WaitingJob & { phoneCiphertext: string };
export type WaitingPatch = Partial<Pick<WaitingJob, "message" | "result">>;
export type WaitingAttempt = {
  id: string; requestId: string; state: WaitingState; startedAt: number;
  submittedAt?: number; finishedAt?: number; result?: WaitingResult; message?: string;
};
type Awaitable<T> = T | Promise<T>;
export interface WaitingRepository {
  catalog(): ReturnType<typeof waitingCatalog> & { serverTime: number };
  job(id: string): Awaitable<WaitingJob>;
  jobs(): Awaitable<WaitingJob[]>;
  pending(): Awaitable<WaitingJob[]>;
  schedule(input: Record<string, unknown>): Awaitable<WaitingJob>;
  phone(id: string): Awaitable<string>;
  transition(id: string, from: WaitingState[], state: WaitingState, patch?: WaitingPatch): Awaitable<WaitingJob>;
  cancel(id: string): Awaitable<WaitingJob>;
  notification(id: string, state: "SENT" | "FAILED"): Awaitable<void>;
  recover(): Awaitable<void>;
  close(): Awaitable<void>;
}

export class WaitingContactCipher {
  #key: Buffer;
  constructor(adminToken: string) {
    if (adminToken.length < 32) throw new AppError("WAITING_KEY_REQUIRED", 500);
    this.#key = createHmac("sha256", adminToken).update("openrun:waiting:phone:v1").digest();
  }
  encrypt(id: string, phone: string): string {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(id));
    const data = Buffer.concat([cipher.update(phone, "utf8"), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map(part => part.toString("base64url")).join(".");
  }
  decrypt(item: Pick<PrivateWaitingJob, "id" | "phoneCiphertext">): string {
    try {
      const [iv, tag, data] = item.phoneCiphertext.split(".").map(part => Buffer.from(part, "base64url"));
      const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
      decipher.setAAD(Buffer.from(item.id)); decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    } catch { throw new AppError("WAITING_CONTACT_UNAVAILABLE", 500); }
  }
  close() { this.#key.fill(0); }
}

export function createWaitingJob(input: Record<string, unknown>, now: number, cipher: WaitingContactCipher): PrivateWaitingJob {
  if (input.confirmed !== true) throw new AppError("WAITING_CONFIRMATION_REQUIRED");
  if (input.restaurantId !== undefined && input.restaurantId !== NANIYORI.id) throw new AppError("INVALID_WAITING_RESTAURANT");
  const opening = nextWaitingOpening(now);
  if (input.openingId !== opening.id) throw new AppError("WAITING_OPENING_CHANGED", 409);
  if (!opening.canRegister) throw new AppError("WAITING_REGISTRATION_NOT_OPEN", 409);
  const partySize = Number(input.partySize);
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > NANIYORI.maxPartySize) throw new AppError("INVALID_PARTY_SIZE");
  if (typeof input.phoneNumber !== "string" || !/^[0-9 -]{10,20}$/.test(input.phoneNumber)) throw new AppError("INVALID_WAITING_PHONE");
  const phone = input.phoneNumber.replace(/[ -]/g, "");
  if (!/^01[016789]\d{7,8}$/.test(phone)) throw new AppError("INVALID_WAITING_PHONE");
  if (input.notify !== undefined && typeof input.notify !== "boolean") throw new AppError("INVALID_NOTIFY");
  const id = randomUUID(), { opensAt } = opening;
  return { id, restaurantId: NANIYORI.id, visitDate: opening.date, slot: opening.slot, partySize,
    phoneMasked: `${phone.slice(0, 3)}-****-${phone.slice(-4)}`, phoneCiphertext: cipher.encrypt(id, phone),
    opensAt, prepareAt: opensAt - WAITING_TIMING.prepareBeforeMs, runsAt: opensAt + WAITING_TIMING.startDelayMs,
    deadline: opensAt + WAITING_TIMING.receptionWindowMs, state: "SCHEDULED", notify: input.notify === true, createdAt: now, updatedAt: now };
}

export function publicWaitingJob(item: PrivateWaitingJob): WaitingJob {
  const { phoneCiphertext: _secret, ...visible } = item;
  return { ...visible, prepareAt: item.prepareAt ?? item.opensAt - WAITING_TIMING.prepareBeforeMs,
    runsAt: item.runsAt ?? item.opensAt + WAITING_TIMING.startDelayMs };
}
