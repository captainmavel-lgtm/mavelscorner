/**
 * MAVEL'S CORNER — PUSH NOTIFICATION SENDER
 * File: netlify/functions/send-push.js
 *
 * Sends push notifications to one or more Expo Push Tokens via the
 * Expo Push API. Protected by a secret so only you can trigger it.
 *
 * Environment variable required (set in Netlify dashboard + local .env):
 *   PUSH_SECRET — any strong string you choose (e.g. a UUID or long passphrase)
 *
 * ── HOW TO TRIGGER MANUALLY ──
 *
 * Using curl in Command Prompt (replace values in angle brackets):
 *
 *   curl -X POST https://mavelscorner.blog/.netlify/functions/send-push ^
 *     -H "Content-Type: application/json" ^
 *     -d "{\"secret\":\"<YOUR_PUSH_SECRET>\",\"type\":\"article\",\"title\":\"New Article\",\"body\":\"A new post is live on Mavel's Corner.\",\"tokens\":[\"<EXPO_PUSH_TOKEN>\"]}"
 *
 * For a podcast episode, change "type" to "podcast":
 *
 *   curl -X POST https://mavelscorner.blog/.netlify/functions/send-push ^
 *     -H "Content-Type: application/json" ^
 *     -d "{\"secret\":\"<YOUR_PUSH_SECRET>\",\"type\":\"podcast\",\"title\":\"New Episode\",\"body\":\"A new episode is now available.\",\"tokens\":[\"<EXPO_PUSH_TOKEN>\"]}"
 *
 * ── REQUEST BODY ──
 * {
 *   "secret":  "<YOUR_PUSH_SECRET>",          // required — must match PUSH_SECRET env var
 *   "type":    "article" | "podcast",          // required — controls the notification data payload
 *   "title":   "New Article",                  // required — notification title shown on device
 *   "body":    "A new post is live...",        // required — notification body text
 *   "tokens":  ["ExponentPushToken[xxx...]"]   // required — one or more Expo push tokens
 * }
 *
 * ── RESPONSE ──
 * 200 — { sent: N, tickets: [...] }
 * 400 — { error: "..." }  (missing fields or bad token format)
 * 401 — { error: "Unauthorised" }  (wrong or missing secret)
 * 500 — { error: "..." }  (Expo API failure)
 */

const https = require('https');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: 'Method not allowed' };
  }

  // ── PARSE BODY ──
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  const { secret, type, title, body: notifBody, tokens } = body;

  // ── AUTHORISATION ──
  const { PUSH_SECRET } = process.env;
  if (!PUSH_SECRET || secret !== PUSH_SECRET) {
    return {
      statusCode: 401,
      headers: CORS,
      body: JSON.stringify({ error: 'Unauthorised' }),
    };
  }

  // ── VALIDATE FIELDS ──
  if (!type || !['article', 'podcast'].includes(type)) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: 'type must be "article" or "podcast"' }),
    };
  }

  if (!title || typeof title !== 'string' || !title.trim()) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: 'title is required' }),
    };
  }

  if (!notifBody || typeof notifBody !== 'string' || !notifBody.trim()) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: 'body is required' }),
    };
  }

  if (!Array.isArray(tokens) || tokens.length === 0) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: 'tokens must be a non-empty array' }),
    };
  }

  // Validate each token looks like an Expo push token
  const invalid = tokens.filter(
    (t) => typeof t !== 'string' || !t.startsWith('ExponentPushToken[')
  );
  if (invalid.length > 0) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({
        error: 'One or more tokens are not valid Expo push tokens',
        invalid,
      }),
    };
  }

  // ── BUILD EXPO MESSAGES ──
  const messages = tokens.map((token) => ({
    to: token,
    sound: 'default',
    title: title.trim(),
    body: notifBody.trim(),
    data: { type }, // app can read this to navigate on tap (Phase 10)
    channelId: type === 'podcast' ? 'podcast-alerts' : 'article-alerts',
  }));

  // ── SEND TO EXPO PUSH API ──
  try {
    const tickets = await sendToExpoPushApi(messages);
    console.log(`send-push: sent ${messages.length} message(s), type=${type}`);
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sent: messages.length, tickets }),
    };
  } catch (e) {
    console.error('send-push error:', e.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Failed to send notifications', detail: e.message }),
    };
  }
};

/* ════════════════════════════════════════════════
   EXPO PUSH API
   Docs: https://docs.expo.dev/push-notifications/sending-notifications/
════════════════════════════════════════════════ */
function sendToExpoPushApi(messages) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(messages);

    const options = {
      hostname: 'exp.host',
      path: '/--/api/v2/push/send',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const chunks = [];
    const req = https.request(options, (res) => {
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          reject(new Error(`Expo API ${res.statusCode}: ${raw}`));
          return;
        }
        try {
          const parsed = JSON.parse(raw);
          resolve(parsed.data || parsed);
        } catch {
          reject(new Error('Failed to parse Expo API response'));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
