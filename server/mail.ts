/**
 * Provider-agnostic email driver — Resend (decided for Phase 8).
 *
 * Exposes `sendMail({to, subject, html, replyTo})`.
 * Self-guarding: if RESEND_API_KEY is unset, logs and skips (doesn't crash).
 *
 * Env:
 *   RESEND_API_KEY  — Resend dashboard → API Keys
 *   MAIL_FROM       — verified sender domain (e.g. noreply@pawsome3d.com)
 */

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const MAIL_FROM = process.env.MAIL_FROM || "";

export interface MailPayload {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
}

/**
 * Send an email via Resend.
 * Never throws — logs warnings on failure.
 * Returns true if the send was attempted, false if skipped (unconfigured).
 */
export async function sendMail(payload: MailPayload): Promise<boolean> {
  if (!RESEND_API_KEY || !MAIL_FROM) {
    console.warn("[mail] RESEND_API_KEY or MAIL_FROM not set — skipping email send");
    return false;
  }
  if (!payload.to || !payload.subject || !payload.html) {
    console.warn("[mail] Missing required fields (to, subject, html) — skipping");
    return false;
  }
  try {
    const body: Record<string, unknown> = {
      from: MAIL_FROM,
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
    };
    if (payload.replyTo) body.reply_to = payload.replyTo;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn(`[mail] Resend returned ${res.status}: ${text}`);
      return false;
    } else {
      const json = await res.json();
      console.log(`[mail] Sent to ${payload.to}: id=${json.id}`);
    }
    return true;
  } catch (e) {
    console.warn("[mail] send failed:", e);
    return false;
  }
}
