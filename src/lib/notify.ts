// ============================================================================
// Seller notifications — you shouldn't have to watch a dashboard.
// ----------------------------------------------------------------------------
// Fires a native macOS notification (osascript) for the moments that matter:
// buyer engaged, escalation needs approval, deal agreed, payment held, payout
// released. Fire-and-forget and best-effort: never throws, never blocks the
// request path, silently does nothing off-macOS or with NOTIFY=off.
// ============================================================================

import { execFile } from "node:child_process";

function enabled(): boolean {
  const flag = (process.env.NOTIFY ?? "on").toLowerCase();
  return flag !== "off" && process.platform === "darwin";
}

export function notify(title: string, body: string): void {
  if (!enabled()) return;
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 200);
  try {
    execFile(
      "osascript",
      ["-e", `display notification "${esc(body)}" with title "${esc(title)}" sound name "Glass"`],
      { timeout: 5000 },
      () => {}
    );
  } catch {
    // never let a notification failure touch the request path
  }
}
