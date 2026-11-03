import { AuthError } from "../errors.ts";

export async function sendBookingNotification(webhook: string, restaurantName: string, summary: string, viewerUrl: string): Promise<void> {
  const url = new URL(webhook);
  if (url.origin !== "https://hooks.slack.com") throw new AuthError("INVALID_SLACK_WEBHOOK", "Slack Incoming Webhook 주소를 확인해 주세요.");
  const response = await fetch(url, {
    method: "POST", signal: AbortSignal.timeout(10000), headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "예약을 진행할 시간이 됐습니다.", unfurl_links: false, unfurl_media: false, blocks: [
      { type: "section", text: { type: "plain_text", text: `${restaurantName}\n${summary}\n서버 브라우저에서 예약 조건을 확인하고 직접 확정해 주세요. 접속 시간은 최대 10분입니다.` } },
      { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "서버 예약 화면 열기" }, url: viewerUrl }] },
    ] }),
  });
  if (!response.ok || (await response.text()).trim() !== "ok") throw new AuthError("SLACK_NOTIFICATION_FAILED", "Slack 알림을 보내지 못했습니다. 관리 화면에서 예약 화면을 열어 주세요.");
}

export async function sendLoginNotification(webhook: string, loginUrl: string, expiresAt: number): Promise<void> {
  const url = new URL(webhook);
  if (url.protocol !== "https:" || url.hostname !== "hooks.slack.com") {
    throw new AuthError("INVALID_SLACK_WEBHOOK", "Slack Incoming Webhook 주소를 확인해 주세요.");
  }
  const result = await fetch(url, {
    method: "POST", signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: "캐치테이블 예약을 위해 로그인을 확인해 주세요.",
      unfurl_links: false, unfurl_media: false,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "*캐치테이블 로그인 확인이 필요합니다*\n서버 브라우저에서 추가 인증을 완료하면 로그인 상태를 저장합니다." } },
        { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "로그인 화면 열기" }, url: loginUrl }] },
        { type: "context", elements: [{ type: "mrkdwn", text: `접속 링크는 ${new Date(expiresAt).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour12: false })} KST까지 유효하며 한 번만 사용할 수 있습니다.` }] },
      ],
    }),
  });
  if (!result.ok || (await result.text()).trim() !== "ok") {
    throw new AuthError("SLACK_NOTIFICATION_FAILED", "Slack 알림을 보내지 못했습니다. 로그인 요청은 유지됩니다.");
  }
}
