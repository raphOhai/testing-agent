// Outgoing email. In staging, SMTP points at a local catcher (Mailpit on :1025).
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const HOST = process.env.SMTP_HOST || '127.0.0.1';
const PORT = Number(process.env.SMTP_PORT || 1025);
const FROM = 'LearnLoop <hello@learnloop.test>';

export function sendMail({ to, subject, text }) {
  const lines = [
    'EHLO learnloop', 'MAIL FROM:<hello@learnloop.test>', `RCPT TO:<${to}>`, 'DATA',
    `From: ${FROM}\r\nTo: <${to}>\r\nSubject: ${subject}\r\nMessage-ID: <${randomUUID()}@learnloop.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text.replace(/^\./gm, '..')}\r\n.`,
    'QUIT',
  ];
  const sock = net.createConnection(PORT, HOST);
  sock.setEncoding('utf8');
  let i = 0; let buf = '';
  sock.on('data', (d) => {
    buf += d;
    while (buf.includes('\r\n')) {
      const line = buf.slice(0, buf.indexOf('\r\n'));
      buf = buf.slice(buf.indexOf('\r\n') + 2);
      if (/^\d{3}-/.test(line)) continue;
      if (i < lines.length) sock.write(`${lines[i++]}\r\n`);
    }
  });
  sock.on('error', (e) => console.error(`[mail] ${to}: ${e.message}`));
}

// Templates
export const mails = {
  verify: (u, link) => ({ to: u.email, subject: 'Confirm your LearnLoop email', text: `Hi ${u.fullName}, confirm your email: ${link}` }),
  receipt: (u, course, cents) => ({ to: u.email, subject: `Receipt: ${course.title}`, text: `You paid ${(cents / 100).toFixed(2)} USD.` }),
  certificate: (u, course) => ({ to: u.email, subject: `Your certificate for ${course.title}`, text: 'Congratulations on finishing!' }),
  refund: (u, course) => ({ to: u.email, subject: `Refund processed: ${course.title}`, text: 'Your refund is on its way.' }),
  finishEnrolling: (u, course) => ({ to: u.email, subject: `Finish enrolling in ${course.title}`, text: 'Your seat is waiting. Complete payment to start.' }),
  studyReminder: (u, course) => ({ to: u.email, subject: `Pick up where you left off in ${course.title}`, text: 'It has been a few days since your last lesson.' }),
};
