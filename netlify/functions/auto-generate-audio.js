/**
 * MAVEL'S CORNER — AUTO AUDIO GENERATION
 * File: netlify/functions/auto-generate-audio.js
 *
 * Triggered automatically after every successful Netlify deploy via webhook.
 * Fetches all posts from posts.json, checks R2 for existing podcast-default
 * audio, and generates missing MP3s using Azure TTS with the default voice.
 *
 * Podcast audio is saved as: blog-{slug}--podcast-default.mp3
 *
 * For existing files: saves real file size (fast HEAD request), duration 0:00
 * For new files:      saves real file size AND real duration (buffer in memory)
 *
 * Metadata is saved to podcast-metadata.json in R2 after EACH episode
 * so a timeout never loses all progress.
 *
 * Default voice: en-CA-ClaraNeural (Female, Canada)
 *
 * Environment variables required:
 *   AZURE_SPEECH_KEY       — Azure Cognitive Services key
 *   AZURE_SPEECH_REGION    — e.g. canadacentral
 *   R2_ACCOUNT_ID          — Cloudflare account ID
 *   R2_ACCESS_KEY_ID       — R2 API token access key ID
 *   R2_SECRET_ACCESS_KEY   — R2 API token secret
 *   R2_BUCKET_NAME         — mavels-corner-audio
 *   R2_PUBLIC_URL          — https://pub-xxx.r2.dev
 *   SITE_URL               — https://mavelscorner.blog
 *   AUTO_GENERATE_SECRET   — secret string to secure the webhook endpoint
 */

const https  = require('https');
const crypto = require('crypto');

const DEFAULT_VOICE      = 'en-CA-ClaraNeural';
const METADATA_FILE_NAME = 'podcast-metadata.json';

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const {
    AZURE_SPEECH_KEY,
    AZURE_SPEECH_REGION,
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME,
    R2_PUBLIC_URL,
    SITE_URL
  } = process.env;

  const siteUrl  = (SITE_URL || 'https://mavelscorner.blog').replace(/\/$/, '');
  const r2Public = (R2_PUBLIC_URL || '').replace(/\/$/, '');

  /* ── LOAD EXISTING METADATA FROM R2 ── */
  let metadata = {};
  try {
    const existing = await getR2File(
      R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
      R2_BUCKET_NAME, METADATA_FILE_NAME
    );
    if (existing) {
      metadata = JSON.parse(existing.toString('utf8'));
    }
  } catch (e) {
    metadata = {};
  }

  /* ── FETCH POSTS ── */
  let posts = [];
  try {
    posts = await fetchJSON(siteUrl + '/posts.json');
  } catch (e) {
    console.error('Failed to fetch posts.json:', e.message);
    return { statusCode: 500, body: 'Failed to fetch posts' };
  }

  if (!posts.length) {
    return { statusCode: 200, body: 'No posts found' };
  }

  const results = [];

  for (const post of posts) {
    if (!post.slug) continue;

    const safeSlug  = post.slug.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').substring(0, 80);
    const fileName  = 'blog-' + safeSlug + '--podcast-default.mp3';
    const publicUrl = r2Public + '/' + fileName;

    /* ── CACHE CHECK ── */
    let fileExists = false;
    try {
      fileExists = await checkR2FileExists(
        R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
        R2_BUCKET_NAME, fileName
      );
    } catch (e) {
      console.warn('Cache check failed for', fileName, e.message);
    }

    /* ── FILE EXISTS BUT MISSING METADATA: fast HEAD request only ── */
    if (fileExists && (!metadata[post.slug] || metadata[post.slug].size === 0)) {
      try {
        const fileSize = await getR2FileSize(
          R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
          R2_BUCKET_NAME, fileName
        );
        // Use 0:00 duration for existing files — platforms read real duration from audio anyway
        metadata[post.slug] = { size: fileSize, duration: '0:00' };

        // Save metadata immediately after each episode
        await saveMetadata(
          R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
          R2_BUCKET_NAME, metadata
        );

        console.log('Backfilled size for:', post.slug, fileSize, 'bytes');
        results.push({ slug: post.slug, status: 'backfilled', url: publicUrl });
      } catch (e) {
        console.warn('Could not backfill size for', fileName, e.message);
      }
      continue;
    }

    /* ── FILE EXISTS AND METADATA IS PRESENT: skip ── */
    if (fileExists && metadata[post.slug] && metadata[post.slug].size > 0) {
      console.log('Already complete, skipping:', fileName);
      results.push({ slug: post.slug, status: 'cached', url: publicUrl });
      continue;
    }

    /* ── FILE DOES NOT EXIST: generate new audio ── */

    // Fetch post content
    let postText = '';
    try {
      postText = await fetchPostText(siteUrl + '/blog/' + post.slug + '/');
    } catch (e) {
      console.warn('Could not fetch post text for', post.slug, e.message);
      postText = post.excerpt || post.title;
    }

    if (!postText || postText.length < 10) {
      postText = post.excerpt || post.title;
    }

    // Generate audio
    let mp3Buffer;
    try {
      mp3Buffer = await generateSpeech(
        AZURE_SPEECH_KEY, AZURE_SPEECH_REGION, postText, DEFAULT_VOICE
      );
    } catch (e) {
      console.error('TTS failed for', post.slug, e.message);
      results.push({ slug: post.slug, status: 'tts-error', error: e.message });
      continue;
    }

    // Upload to R2
    try {
      await uploadToR2(
        R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
        R2_BUCKET_NAME, fileName, mp3Buffer
      );

      // Real size and duration since buffer is in memory
      const fileSize = mp3Buffer.length;
      const duration = calculateMp3Duration(mp3Buffer);
      metadata[post.slug] = { size: fileSize, duration };

      // Save metadata immediately after each episode
      await saveMetadata(
        R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
        R2_BUCKET_NAME, metadata
      );

      console.log('Generated:', fileName, fileSize, 'bytes,', duration);
      results.push({ slug: post.slug, status: 'generated', url: publicUrl });
    } catch (e) {
      console.error('Upload failed for', post.slug, e.message);
      results.push({ slug: post.slug, status: 'upload-error', error: e.message });
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ processed: results.length, results })
  };
};

/* ════════════════════════════════════════════════
   SAVE METADATA TO R2
   Called after every single episode so a timeout
   never loses all progress.
════════════════════════════════════════════════ */
async function saveMetadata(accountId, accessKeyId, secretKey, bucket, metadata) {
  const metaBuffer = Buffer.from(JSON.stringify(metadata, null, 2), 'utf8');
  await uploadToR2(accountId, accessKeyId, secretKey, bucket, METADATA_FILE_NAME, metaBuffer, 'application/json');
  console.log('Saved podcast-metadata.json');
}

/* ════════════════════════════════════════════════
   CALCULATE MP3 DURATION FROM BUFFER
════════════════════════════════════════════════ */
function calculateMp3Duration(buffer) {
  try {
    let offset = 0;

    // Skip ID3v2 tag if present
    if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
      const id3Size =
        ((buffer[6] & 0x7f) << 21) |
        ((buffer[7] & 0x7f) << 14) |
        ((buffer[8] & 0x7f) << 7)  |
         (buffer[9] & 0x7f);
      offset = 10 + id3Size;
    }

    const bitrateTable   = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
    const sampleRateTable = [44100, 48000, 32000, 0];

    let totalFrames     = 0;
    let samplesPerFrame = 1152;
    let sampleRate      = 44100;
    let foundFirst      = false;

    while (offset + 4 < buffer.length) {
      if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) {
        offset++;
        continue;
      }

      const h1 = buffer[offset + 1];
      const h2 = buffer[offset + 2];

      const mpegVersion = (h1 >> 3) & 0x03;
      const layer       = (h1 >> 1) & 0x03;
      const bitrateIdx  = (h2 >> 4) & 0x0f;
      const sampleIdx   = (h2 >> 2) & 0x03;
      const padding     = (h2 >> 1) & 0x01;

      if (mpegVersion !== 3 || layer !== 1 || bitrateIdx === 0 || bitrateIdx === 15) {
        offset++;
        continue;
      }

      const bitrate = bitrateTable[bitrateIdx] * 1000;
      const sr      = sampleRateTable[sampleIdx];
      if (bitrate === 0 || sr === 0) { offset++; continue; }

      if (!foundFirst) { sampleRate = sr; foundFirst = true; }

      const frameSize = Math.floor((samplesPerFrame / 8 * bitrate) / sr) + padding;
      totalFrames++;
      offset += frameSize || 1;
    }

    const totalSeconds = Math.round((totalFrames * samplesPerFrame) / sampleRate);
    const hrs  = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;

    if (hrs > 0) {
      return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${mins}:${String(secs).padStart(2, '0')}`;
  } catch (e) {
    return '0:00';
  }
}

/* ════════════════════════════════════════════════
   FETCH POST TEXT FROM PUBLISHED PAGE
════════════════════════════════════════════════ */
function fetchPostText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const articleMatch = data.match(/<div class="article-inner">([\s\S]*?)<hr/i);
        let raw = articleMatch ? articleMatch[1] : '';

        if (!raw || raw.trim().length < 10) { resolve(''); return; }

        raw = removeDiv(raw, 'post-tags');

        const text = raw
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ').trim().substring(0, 50000);

        resolve(text);
      });
    }).on('error', reject);
  });
}

function removeDiv(html, className) {
  const openPattern = new RegExp('<div[^>]+class="[^"]*' + className + '[^"]*"[^>]*>', 'i');
  const match = openPattern.exec(html);
  if (!match) return html;

  const start = match.index;
  let pos = start + match[0].length;
  let depth = 1;

  while (pos < html.length && depth > 0) {
    const nextOpen  = html.indexOf('<div', pos);
    const nextClose = html.indexOf('</div>', pos);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) { depth++; pos = nextOpen + 4; }
    else { depth--; pos = nextClose + 6; }
  }

  return html.substring(0, start) + html.substring(pos);
}

/* ════════════════════════════════════════════════
   FETCH JSON
════════════════════════════════════════════════ */
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

/* ════════════════════════════════════════════════
   AZURE TTS
════════════════════════════════════════════════ */
function generateSpeech(key, region, text, voiceName) {
  return new Promise((resolve, reject) => {
    const safe = text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
════════════════════════════════════════════════ */
function hmac(key, data, encoding) {
  return crypto.createHmac('sha256', key).update(data).digest(encoding);
}

function hash(data, encoding) {
  return crypto.createHash('sha256').update(data).digest(encoding);
}

function signV4(method, url, headers, body, accessKeyId, secretKey, region, service, date) {
  const parsedUrl    = new URL(url);
  const dateStamp    = date.substring(0, 8);
  const canonicalUri = parsedUrl.pathname;
  const canonicalQS  = parsedUrl.searchParams.toString();

  const signedHeaders    = Object.keys(headers).map(k => k.toLowerCase()).sort().join(';');
  const canonicalHeaders = Object.keys(headers)
    .map(k => k.toLowerCase() + ':' + headers[k].trim())
    .sort().join('\n') + '\n';

  const payloadHash      = hash(body || '', 'hex');
  const canonicalRequest = [method, canonicalUri, canonicalQS, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope  = [dateStamp, region, service, 'aws4_request'].join('/');
  const stringToSign     = ['AWS4-HMAC-SHA256', date, credentialScope, hash(canonicalRequest, 'hex')].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac('AWS4' + secretKey, dateStamp), region), service),
    'aws4_request'
  );
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${hmac(signingKey, stringToSign, 'hex')}`;
}

function r2Request(method, accountId, accessKeyId, secretKey, bucket, key, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const url     = `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${key}`;
    const now     = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').substring(0, 15) + 'Z';
    const parsed  = new URL(url);

    const headers = {
      'Host':                  parsed.hostname,
      'x-amz-date':           amzDate,
      'x-amz-content-sha256': hash(body || '', 'hex'),
      ...extraHeaders
    };

    if (body) headers['Content-Length'] = Buffer.byteLength(body).toString();
    headers['Authorization'] = signV4(method, url, headers, body, accessKeyId, secretKey, 'auto', 's3', amzDate);

    const chunks = [];
    const req = https.request({ hostname: parsed.hostname, path: parsed.pathname, method, headers }, (res) => {
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
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

async function getR2FileSize(accountId, accessKeyId, secretKey, bucket, key) {
  const res = await r2Request('HEAD', accountId, accessKeyId, secretKey, bucket, key, null, {});
  if (res.status !== 200) return 0;
  const cl = res.headers && res.headers['content-length'];
  return cl ? parseInt(cl, 10) : 0;
}

async function getR2File(accountId, accessKeyId, secretKey, bucket, key) {
  const res = await r2Request('GET', accountId, accessKeyId, secretKey, bucket, key, null, {});
  if (res.status !== 200) return null;
  return res.body;
}

async function uploadToR2(accountId, accessKeyId, secretKey, bucket, key, buffer, contentType) {
  const res = await r2Request('PUT', accountId, accessKeyId, secretKey, bucket, key, buffer, {
    'Content-Type': contentType || 'audio/mpeg'
  });
  if (res.status !== 200 && res.status !== 201 && res.status !== 204) {
    throw new Error(`R2 PUT returned ${res.status}: ${res.body.toString()}`);
  }
}
