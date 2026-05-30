/**
 * MAVEL'S CORNER — AUDIO GENERATION FUNCTION
 * File: netlify/functions/generate-audio.js
 *
 * Called by the audio player when a reader opens a post.
 * 1. Checks if MP3 already exists in R2 (cache hit — returns URL immediately)
 * 2. If not, calls Azure TTS to generate the MP3
 * 3. Uploads the MP3 to Cloudflare R2
 * 4. Returns the public URL
 *
 * Environment variables required (set in Netlify dashboard):
 *   AZURE_SPEECH_KEY       — Azure Cognitive Services key
 *   AZURE_SPEECH_REGION    — e.g. canadacentral
 *   R2_ACCOUNT_ID          — Cloudflare account ID
 *   R2_ACCESS_KEY_ID       — R2 API token access key ID
 *   R2_SECRET_ACCESS_KEY   — R2 API token secret
 *   R2_BUCKET_NAME         — mavels-corner-audio
 *   R2_PUBLIC_URL          — https://pub-xxx.r2.dev
 */

const https  = require('https');
const http   = require('http');
const crypto = require('crypto');

/* ── CORS HEADERS ── */
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: 'Method not allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers: CORS, body: 'Invalid JSON' };
  }

  const { text, postSlug, voice } = body;

  if (!text || !postSlug) {
    return { statusCode: 400, headers: CORS, body: 'Missing text or postSlug' };
  }

  const {
    AZURE_SPEECH_KEY,
    AZURE_SPEECH_REGION,
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME,
    R2_PUBLIC_URL
  } = process.env;

  /* ── CACHE CHECK ── */
  // Build a deterministic filename from the post slug and voice
  const voiceName   = voice || 'en-CA-ClaraNeural';
  const safeSlug    = postSlug.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').substring(0, 80);
  const fileName    = safeSlug + '--' + voiceName.toLowerCase().replace(/[^a-z0-9]/g, '-') + '.mp3';
  const publicUrl   = R2_PUBLIC_URL.replace(/\/$/, '') + '/' + fileName;

  // Check if file already exists in R2
  try {
    const exists = await checkR2FileExists(
      R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
      R2_BUCKET_NAME, fileName
    );
    if (exists) {
      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: publicUrl, cached: true })
      };
    }
  } catch (e) {
    // If cache check fails, proceed to generate
  }

  /* ── AZURE TTS ── */
  let mp3Buffer;
  try {
    mp3Buffer = await generateSpeech(AZURE_SPEECH_KEY, AZURE_SPEECH_REGION, text, voiceName);
  } catch (e) {
    console.error('Azure TTS error:', e.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'TTS generation failed', detail: e.message })
    };
  }

  /* ── UPLOAD TO R2 ── */
  try {
    await uploadToR2(
      R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
      R2_BUCKET_NAME, fileName, mp3Buffer
    );
  } catch (e) {
    console.error('R2 upload error:', e.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Upload failed', detail: e.message })
    };
  }

  return {
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: publicUrl, cached: false })
  };
};

/* ════════════════════════════════════════════════
   AZURE TTS
════════════════════════════════════════════════ */
function generateSpeech(key, region, text, voiceName) {
  return new Promise((resolve, reject) => {
    // Sanitise text for SSML
    const safe = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-CA">
  <voice name="${voiceName}">
    <prosody rate="0%" pitch="0%">
      ${safe}
    </prosody>
  </voice>
</speak>`;

    const options = {
      hostname: `${region}.tts.speech.microsoft.com`,
      path:     '/cognitiveservices/v1',
      method:   'POST',
      headers:  {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type':              'application/ssml+xml',
        'X-Microsoft-OutputFormat':  'audio-48khz-96kbitrate-mono-mp3',
        'User-Agent':                'MavelsCorner'
      }
    };

    const chunks = [];
    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        let err = '';
        res.on('data', d => err += d);
        res.on('end', () => reject(new Error(`Azure TTS ${res.statusCode}: ${err}`)));
        return;
      }
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });

    req.on('error', reject);
    req.write(ssml);
    req.end();
  });
}

/* ════════════════════════════════════════════════
   CLOUDFLARE R2 — AWS S3-COMPATIBLE API
   Uses SigV4 signing (no SDK required)
════════════════════════════════════════════════ */
function getR2Endpoint(accountId) {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

function hmac(key, data, encoding) {
  return crypto.createHmac('sha256', key).update(data).digest(encoding);
}

function hash(data, encoding) {
  return crypto.createHash('sha256').update(data).digest(encoding);
}

function signV4(method, url, headers, body, accessKeyId, secretKey, region, service, date) {
  const parsedUrl    = new URL(url);
  const dateStamp    = date.substring(0, 8);
  const amzDate      = date;
  const canonicalUri = parsedUrl.pathname;
  const canonicalQS  = parsedUrl.searchParams.toString();

  const signedHeaders = Object.keys(headers).map(k => k.toLowerCase()).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .map(k => k.toLowerCase() + ':' + headers[k].trim())
    .sort()
    .join('\n') + '\n';

  const payloadHash      = hash(body || '', 'hex');
  const canonicalRequest = [method, canonicalUri, canonicalQS, canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const credentialScope  = [dateStamp, region, service, 'aws4_request'].join('/');
  const stringToSign     = ['AWS4-HMAC-SHA256', amzDate, credentialScope, hash(canonicalRequest, 'hex')].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac('AWS4' + secretKey, dateStamp), region), service),
    'aws4_request'
  );
  const signature  = hmac(signingKey, stringToSign, 'hex');

  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function r2Request(method, accountId, accessKeyId, secretKey, bucket, key, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const endpoint = getR2Endpoint(accountId);
    const url      = `${endpoint}/${bucket}/${key}`;
    const now      = new Date();
    const amzDate  = now.toISOString().replace(/[:-]|\.\d{3}/g, '').substring(0, 15) + 'Z';
    const parsed   = new URL(url);

    const headers = {
      'Host':                 parsed.hostname,
      'x-amz-date':          amzDate,
      'x-amz-content-sha256': hash(body || '', 'hex'),
      ...extraHeaders
    };

    if (body) headers['Content-Length'] = Buffer.byteLength(body).toString();

    const auth = signV4(method, url, headers, body, accessKeyId, secretKey, 'auto', 's3', amzDate);
    headers['Authorization'] = auth;

    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname,
      method,
      headers
    };

    const chunks = [];
    const req = https.request(options, (res) => {
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function checkR2FileExists(accountId, accessKeyId, secretKey, bucket, key) {
  const res = await r2Request('HEAD', accountId, accessKeyId, secretKey, bucket, key, null, {});
  return res.status === 200;
}

async function uploadToR2(accountId, accessKeyId, secretKey, bucket, key, buffer) {
  const res = await r2Request('PUT', accountId, accessKeyId, secretKey, bucket, key, buffer, {
    'Content-Type': 'audio/mpeg'
  });
  if (res.status !== 200 && res.status !== 201 && res.status !== 204) {
    throw new Error(`R2 PUT returned ${res.status}: ${res.body.toString()}`);
  }
}
