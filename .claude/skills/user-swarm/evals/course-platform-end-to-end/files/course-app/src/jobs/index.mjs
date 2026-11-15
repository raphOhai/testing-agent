// Scheduled jobs. In production these run from cron (see SCHEDULE); in staging they can also be
// triggered by POST /internal/cron/:job with an optional { "now": "<ISO date>" } body.
import { db } from '../store.mjs';
import { sendMail, mails } from '../mailer.mjs';

const HOUR = 3600e3;
const DAY = 24 * HOUR;

export const SCHEDULE = {
  'unpaid-enrollment-nudge': '*/15 * * * *', // every 15 minutes
  'study-reminder': '0 9 * * *',              // daily at 09:00
};

export const jobs = {
  // Enrolled but didn't pay within 1 hour → "Finish enrolling" email (once).
  'unpaid-enrollment-nudge'(now) {
    let sent = 0;
    for (const e of db.enrollments.values()) {
      if (e.status === 'pending_payment' && !e.nudgedAt && now - e.createdAt >= HOUR) {
        sendMail(mails.finishEnrolling(db.learners.get(e.learnerId), db.courses.get(e.courseId)));
        e.nudgedAt = now; sent++;
      }
    }
    return { sent };
  },

  // Paid learners with no lesson activity for 3 days → study reminder (once).
  'study-reminder'(now) {
    let sent = 0;
    for (const e of db.enrollments.values()) {
      const idle = now - (e.lastActivityAt || e.paidAt || e.createdAt) >= 3 * DAY;
      if (e.paidAt && e.status !== 'refunded' && !e.remindedAt && idle) {
        sendMail(mails.studyReminder(db.learners.get(e.learnerId), db.courses.get(e.courseId)));
        e.remindedAt = now; sent++;
      }
    }
    return { sent };
  },
};
