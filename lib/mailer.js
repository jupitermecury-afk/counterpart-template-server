const nodemailer = require('nodemailer');

// Real, person-triggered email sending — the model only ever calls prepare_email_draft
// (see lib/claude.js); it never decides on its own to actually send anything. This sends
// from ONE shared, organizational Gmail account (an app password, not the account's real
// password), never a per-user identity.
let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.GMAIL_SMTP_USER || !process.env.GMAIL_SMTP_APP_PASSWORD) return null;
  transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.GMAIL_SMTP_USER,
      pass: process.env.GMAIL_SMTP_APP_PASSWORD,
    },
  });
  return transporter;
}

function isMailerConfigured() {
  return !!(process.env.GMAIL_SMTP_USER && process.env.GMAIL_SMTP_APP_PASSWORD);
}

/**
 * Sends a real email from the shared account. Throws on failure — callers should catch
 * and turn that into a clean { ok: false, error } response, never let it crash the request.
 */
async function sendRealEmail({ to, subject, body }) {
  const t = getTransporter();
  if (!t) throw new Error('email sending is not configured on this server');
  if (!to) throw new Error('no recipient address on this draft');

  await t.sendMail({
    from: process.env.GMAIL_SMTP_USER,
    to,
    subject: subject || '(no subject)',
    text: body || '',
  });
}

module.exports = { sendRealEmail, isMailerConfigured };
