/**
 * Twilio PSTN test call (real phone call).
 *
 * Usage:
 *   TWILIO_TO="+1..." TWILIO_FROM="+1..." node call.js
 *   # or:
 *   node call.js "+1..." "+1..."
 *
 * Credentials must come from environment variables.
 */

const twilio = require('twilio');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

const to = process.env.TWILIO_TO || process.argv[2];
const from = process.env.TWILIO_FROM || process.argv[3];

if (!to || !from) {
  console.error('Missing required args.');
  console.error('Set TWILIO_TO and TWILIO_FROM, or run: node call.js "<to>" "<from>"');
  process.exit(1);
}

if (!accountSid || !authToken) {
  console.error('Missing Twilio credentials.');
  console.error('Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN environment variables.');
  process.exit(1);
}

const client = twilio(accountSid, authToken);

// Inline TwiML so you don't need to host a TwiML URL.
const twiml = '<Response><Say voice="alice">Twilio test call from Node.js SDK.</Say></Response>';

client.calls
  .create({ to, from, twiml })
  .then((call) => {
    console.log(call.sid);
  })
  .catch((err) => {
    console.error('Twilio call creation failed:');
    console.error(err?.message || err);
    process.exit(1);
  });

