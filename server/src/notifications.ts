import { randomBytes } from "node:crypto";
import { Router } from "express";
import { requireViewer, userById, viewerOf } from "./auth.js";
import { config } from "./config.js";
import type { AppNotification } from "./contract.js";
import { HttpError } from "./errors.js";
import { wrap } from "./httpUtil.js";
import { mailer as defaultMailer, type Mailer } from "./mailer.js";
import { store, type NotificationRecord, type ReviewRecord } from "./store.js";

const toClient = ({ userId: _userId, ...n }: NotificationRecord): AppNotification => n;

/**
 * Tells the student their feedback is ready: an in-app notification, then an
 * email. Never throws. A failed email is logged and the in-app notification
 * stands, so a mail outage can't fail a finished review.
 */
export async function notifyFeedbackReady(review: Pick<ReviewRecord, "id" | "title" | "studentId">, mailer: Mailer = defaultMailer): Promise<void> {
  try {
    store.putNotification({
      id: randomBytes(12).toString("hex"),
      userId: review.studentId,
      kind: "FEEDBACK_READY",
      reviewId: review.id,
      title: "Your feedback is ready",
      body: `"${review.title}" has been reviewed.`,
      createdAt: new Date().toISOString(),
    });
    const user = userById(review.studentId);
    if (!user?.email) return void console.warn(`[notify] review ${review.id}: no email address for ${review.studentId}, so no email was sent`);
    await mailer.send({
      to: user.email,
      subject: `Your feedback is ready: ${review.title}`,
      text: `Hi ${user.name},\n\nThe feedback on "${review.title}" is ready. Open Video Review to step through it:\n${config.appUrl}\n`,
    });
  } catch (e) {
    console.error(`[notify] review ${review.id}: couldn't notify:`, e instanceof Error ? e.message : e);
  }
}

/** `/notifications`: the caller's own in-app notifications. */
export function createNotificationRouter(): Router {
  const r = Router();
  r.use(requireViewer);

  r.get(
    "/",
    wrap((_req, res) => {
      const mine = store.listNotifications(viewerOf(res).id);
      res.json({ notifications: mine.map(toClient), unreadCount: mine.filter((n) => !n.readAt).length });
    }),
  );

  r.post(
    "/read-all",
    wrap((_req, res) => {
      const now = new Date().toISOString();
      for (const n of store.listNotifications(viewerOf(res).id)) if (!n.readAt) store.putNotification({ ...n, readAt: now });
      res.json({ ok: true });
    }),
  );

  r.post(
    "/:id/read",
    wrap((req, res) => {
      const n = store.getNotification(req.params.id);
      // Someone else's notification looks exactly like one that doesn't exist.
      if (!n || n.userId !== viewerOf(res).id) throw new HttpError(404, "That notification doesn't exist.", "NOT_FOUND");
      res.json({ notification: toClient(n.readAt ? n : store.putNotification({ ...n, readAt: new Date().toISOString() })) });
    }),
  );

  return r;
}
