import { AppError } from "../app/store.ts";

// Ported from bots-on-lambda/syrupWaitingForNaniyori (e28c04b).
// These slots/closed days are the existing bot's configuration, not a live
// guarantee of restaurant availability. No recurring schedule is enabled.
export const NANIYORI = {
  id: "naniyori", name: "나니요리", provider: "SYRUP",
  url: "https://wait.syrupfriends.com/waiting/link/XlGXn1Qav79OJGqu",
  maxPartySize: 8, closedWeekdays: [1, 4] as number[],
  slots: [{ id: "am", label: "오전", time: "10:00" }, { id: "pm", label: "오후", time: "16:00" }],
} as const;
export type WaitingSlot = "am" | "pm";
export const WAITING_TIMING = { prepareBeforeMs: 120_000, startDelayMs: 1_000, receptionWindowMs: 120_000 } as const;
export function kstDate(now = Date.now()): string { return new Date(now + 9 * 3600000).toISOString().slice(0, 10); }
export function tomorrowDate(now = Date.now()): string { return kstDate(now + 86400000); }
export function isClosed(date: string): boolean {
  return NANIYORI.closedWeekdays.includes(new Date(`${date}T12:00:00+09:00`).getUTCDay());
}
export function slotTime(date: string, slot: WaitingSlot): number {
  const entry = NANIYORI.slots.find(item => item.id === slot);
  if (!entry) throw new AppError("INVALID_WAITING_SLOT");
  return Date.parse(`${date}T${entry.time}:00+09:00`);
}
export function tomorrowWaitingOpening(now = Date.now()) {
  const date = tomorrowDate(now), slot = NANIYORI.slots[0], closed = isClosed(date);
  return { id: `${date}:${slot.id}:${slot.time}`, date, slot: slot.id, opensAt: slotTime(date, slot.id), closed, canRegister: !closed };
}
export function waitingCatalog(now = Date.now()) {
  return { restaurant: NANIYORI, nextOpening: tomorrowWaitingOpening(now) };
}
