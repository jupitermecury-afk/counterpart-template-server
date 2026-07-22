// Real, person-triggered email sending — the model only ever calls prepare_email_draft
// (see lib/claude.js); it never decides on its own to actually send anything. Sends from
// ONE shared, organizational address, never a per-user identity.
//
// Uses SendGrid's HTTP API rather than raw SMTP: Railway blocks outbound SMTP ports
// (465/587) below the Pro plan, so a direct nodemailer/SMTP connection just hangs and
// times out — this sidesteps that entirely, since it's a plain HTTPS call.
//
// SENDGRID_FROM_EMAIL is verified via SendGrid's "Single Sender" flow (a confirmation
// link sent to that inbox) rather than full domain verification — fine for getting this
// working now, but SendGrid itself flags this as lower-deliverability than a verified
// domain (no DKIM/SPF), a known, accepted tradeoff here, not an oversight.

function isMailerConfigured() {
  return !!(process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM_EMAIL);
}

/**
 * Sends a real email from the shared account. Throws on failure — callers should catch
 * and turn that into a clean { ok: false, error } response, never let it crash the request.
 */
async function sendRealEmail({ to, subject, body }) {
  if (!isMailerConfigured()) throw new Error('email sending is not configured on this server');
  if (!to) throw new Error('no recipient address on this draft');

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: process.env.SENDGRID_FROM_EMAIL },
      subject: subject || '(no subject)',
      content: [{ type: 'text/plain', value: body || '' }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`SendGrid error ${response.status}: ${errText}`);
  }
}

module.exports = { sendRealEmail, isMailerConfigured };
