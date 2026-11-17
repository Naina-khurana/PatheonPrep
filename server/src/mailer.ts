import { config } from "./config.js";

export interface Email {
  to: string;
  subject: string;
  text: string;
}

/** Anything that can deliver an email. Swap the provider by writing another one of these. */
export interface Mailer {
  send(email: Email): Promise<void>;
}

/** Used when no provider is configured: the email is logged, not sent. */
export const logMailer: Mailer = {
  async send(email) {
    console.log(`[mail] not configured, so not sent. To: ${email.to} | Subject: ${email.subject}`);
  },
};

/** Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email). */
export function resendMailer(apiKey: string, from: string): Mailer {
  return {
    async send(email) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [email.to], subject: email.subject, text: email.text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Resend answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    },
  };
}

export const mailer: Mailer = config.resendApiKey && config.emailFrom ? resendMailer(config.resendApiKey, config.emailFrom) : logMailer;
