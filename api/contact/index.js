const sgMail = require('@sendgrid/mail');
const { TableClient } = require('@azure/data-tables');

const TABLE_NAME = 'contactsubmissions';

async function logSubmission(entry) {
  try {
    const client = TableClient.fromConnectionString(
      process.env.STORAGE_CONNECTION_STRING,
      TABLE_NAME
    );
    await client.createTableIfNotExists();
    await client.createEntity(entry);
  } catch (err) {
    // Logging failure should never block the form response
  }
}

module.exports = async function (context, req) {
  const allowedOrigins = [
    'https://salmon-wave-0ebb6bb0f.7.azurestaticapps.net',
    'https://www.helicopterswivels.com',
    'https://helicopterswivels.com'
  ];
  const origin = req.headers['origin'] || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  const headers = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (req.method === 'OPTIONS') {
    context.res = { status: 204, headers };
    return;
  }

  const { name, email, phone, message, website } = req.body || {};
  const timestamp = new Date().toISOString();
  const rowKey = timestamp.replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 7);
  const ip = req.headers['x-forwarded-for'] || req.headers['client-ip'] || 'unknown';

  // Honeypot — bots fill this hidden field, humans don't
  if (website) {
    await logSubmission({
      partitionKey: 'spam',
      rowKey,
      timestamp,
      name: name || '',
      email: email || '',
      phone: phone || '',
      message: (message || '').slice(0, 500),
      ip,
      status: 'honeypot'
    });
    context.res = { status: 200, headers, body: { success: true } };
    return;
  }

  if (!name || !email || !message) {
    context.res = {
      status: 400,
      headers,
      body: { error: 'Name, email, and message are required.' }
    };
    return;
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    context.res = {
      status: 400,
      headers,
      body: { error: 'Invalid email address.' }
    };
    return;
  }

  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  const msg = {
    to: process.env.TO_EMAIL,
    from: process.env.FROM_EMAIL,
    replyTo: email,
    subject: `Website enquiry from ${name}`,
    text: [
      `Name: ${name}`,
      `Email: ${email}`,
      `Phone: ${phone || 'Not provided'}`,
      '',
      `Message:`,
      message
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#0f2340;border-bottom:2px solid #dbeeff;padding-bottom:0.5rem;">
          New enquiry — helicopterswivels.com
        </h2>
        <table style="width:100%;border-collapse:collapse;margin:1.5rem 0;">
          <tr><td style="padding:0.5rem 0;color:#8aa0b8;width:120px;">Name</td><td style="padding:0.5rem 0;color:#0f2340;font-weight:bold;">${escapeHtml(name)}</td></tr>
          <tr><td style="padding:0.5rem 0;color:#8aa0b8;">Email</td><td style="padding:0.5rem 0;"><a href="mailto:${escapeHtml(email)}" style="color:#1e6eb5;">${escapeHtml(email)}</a></td></tr>
          <tr><td style="padding:0.5rem 0;color:#8aa0b8;">Phone</td><td style="padding:0.5rem 0;color:#0f2340;">${escapeHtml(phone || 'Not provided')}</td></tr>
        </table>
        <div style="background:#f5f8fb;border-left:3px solid #1e6eb5;padding:1rem 1.25rem;border-radius:2px;">
          <p style="color:#8aa0b8;font-size:0.8rem;margin:0 0 0.5rem;">Message</p>
          <p style="color:#0f2340;margin:0;white-space:pre-wrap;">${escapeHtml(message)}</p>
        </div>
      </div>
    `
  };

  try {
    await sgMail.send(msg);
    await logSubmission({
      partitionKey: 'sent',
      rowKey,
      timestamp,
      name,
      email,
      phone: phone || '',
      message: message.slice(0, 500),
      ip,
      status: 'sent'
    });
    context.res = {
      status: 200,
      headers,
      body: { success: true }
    };
  } catch (err) {
    context.log.error('SendGrid error:', err.response?.body || err.message);
    await logSubmission({
      partitionKey: 'error',
      rowKey,
      timestamp,
      name,
      email,
      phone: phone || '',
      message: message.slice(0, 500),
      ip,
      status: 'error',
      errorDetail: String(err.message || '').slice(0, 200)
    });
    context.res = {
      status: 500,
      headers,
      body: { error: 'Failed to send message. Please try again or contact us directly.' }
    };
  }
};

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
