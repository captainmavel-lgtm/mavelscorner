/**
 * MAVEL'S CORNER — PODCAST RSS FEED
 * File: netlify/functions/podcast-feed.js
 *
 * Generates a valid RSS 2.0 podcast feed from your published posts.
 * Each post that has a generated MP3 in R2 appears as a podcast episode.
 *
 * Real file sizes and durations are read from podcast-metadata.json stored
 * in R2, which is written and maintained by auto-generate-audio.js.
 *
 * Access at: https://mavelscorner.blog/.netlify/functions/podcast-feed
 * Submit this URL to Spotify, Apple Podcasts, Amazon Music, and YouTube Music.
 *
 * Environment variables required:
 *   R2_ACCOUNT_ID        — Cloudflare account ID
 *   R2_ACCESS_KEY_ID     — R2 API token access key ID
 *   R2_SECRET_ACCESS_KEY — R2 API token secret
 *   R2_BUCKET_NAME       — mavels-corner-audio
 *   R2_PUBLIC_URL        — https://pub-xxx.r2.dev
 *   SITE_URL             — https://mavelscorner.blog
 */

const https  = require('https');
const crypto = require('crypto');

const METADATA_FILE_NAME = 'podcast-metadata.json';

exports.handler = async function (event) {
  const SITE_URL   = (process.env.SITE_URL   || 'https://mavelscorner.blog').replace(/\/$/, '');
  const R2_PUBLIC  = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');

  const {
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME
  } = process.env;

  /* ── PODCAST METADATA ── */
  const podcast = {
    title:       "Mavel's Corner",
    description: "A faith-based podcast for young adults and millennials exploring faith, hope and the beauty of second chances with God. New episodes with every post from mavelscorner.blog",
    link:        SITE_URL,
    language:    'en',
    author:      'Emmanuel Avleshie',
    email:       'mavelscorner@outlook.com',
    category:    'Religion &amp; Spirituality',
    subcategory: 'Christianity',
    image:       SITE_URL + '/images/podcast-cover.jpg',
    explicit:    'false',
    copyright:   `\u00a9 ${new Date().getFullYear()} Mavel's Corner. All rights reserved.`
  };

  /* ── FETCH POSTS FROM SITE ── */
  let posts = [];
  try {
    posts = await fetchJSON(SITE_URL + '/posts.json');
  } catch (e) {
    posts = [];
  }

  /* ── LOAD AUDIO METADATA FROM R2 ── */
  let audioMeta = {};
  try {
    const metaBuffer = await getR2File(
      R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
      R2_BUCKET_NAME, METADATA_FILE_NAME
    );
    if (metaBuffer) {
      audioMeta = JSON.parse(metaBuffer.toString('utf8'));
    }
  } catch (e) {
    // Metadata not yet generated — feed will use 0 values as fallback
    audioMeta = {};
  }

  /* ── BUILD RSS ITEMS ── */
  const items = posts
    .filter(p => p.slug)
    .map(p => {
      const safeSlug = p.slug.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').substring(0, 80);
      const audioUrl = R2_PUBLIC + '/blog-' + safeSlug + '--podcast-default.mp3';
      const pubDate  = new Date(p.date).toUTCString();
      const postUrl  = SITE_URL + '/blog/' + p.slug + '/';

      // Read real values from metadata, fall back gracefully if not yet available
      const meta     = audioMeta[p.slug] || {};
      const fileSize = meta.size     || 0;
      const duration = meta.duration || '0:00';

      return `
    <item>
      <title>${escapeXml(p.title)}</title>
      <link>${postUrl}</link>
      <guid isPermaLink="true">${postUrl}</guid>
      <description>${escapeXml(p.excerpt || p.title)}</description>
      <pubDate>${pubDate}</pubDate>
      <enclosure url="${audioUrl}" length="${fileSize}" type="audio/mpeg"/>
      <itunes:title>${escapeXml(p.title)}</itunes:title>
      <itunes:author>Emmanuel Avleshie</itunes:author>
      <itunes:summary>${escapeXml(p.excerpt || p.title)}</itunes:summary>
      <itunes:duration>${duration}</itunes:duration>
      <itunes:explicit>false</itunes:explicit>
    </item>`;
    })
    .join('\n');

  /* ── BUILD RSS FEED ── */
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:atom="http://www.w3.org/2005/Atoms">
  <channel>
    <title>${podcast.title}</title>
    <link>${podcast.link}</link>
    <description>${podcast.description}</description>
    <language>${podcast.language}</language>
    <copyright>${podcast.copyright}</copyright>
    <managingEditor>${podcast.email} (${podcast.author})</managingEditor>
    <atom:link href="${SITE_URL}/.netlify/functions/podcast-feed" rel="self" type="application/rss+xml"/>
    <itunes:author>${podcast.author}</itunes:author>
    <itunes:owner>
      <itunes:name>${podcast.author}</itunes:name>
      <itunes:email>${podcast.email}</itunes:email>
    </itunes:owner>
    <itunes:category text="${podcast.category}">
      <itunes:category text="${podcast.subcategory}"/>
    </itunes:category>
    <itunes:image href="${podcast.image}"/>
    <itunes:explicit>${podcast.explicit}</itunes:explicit>
    <itunes:type>episodic</itunes:type>
    <image>
      <url>${podcast.image}</url>
      <title>${podcast.title}</title>
      <link>${podcast.link}</link>
    </image>
    ${items}
  </channel>
</rss>`;

  return {
    statusCode: 200,
    headers: {
      'Content-Type':  'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600'
    },
    body: rss
  };
};

/* ════════════════════════════════════════════════
   FETCH JSON
════════════════════════════════════════════════ */
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? require('https') : require('http');
    lib.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');
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
    .sort()
    .join('\n') + '\n';

  const payloadHash      = hash(body || '', 'hex');
  const canonicalRequest = [method, canonicalUri, canonicalQS, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope  = [dateStamp, region, service, 'aws4_request'].join('/');
  const stringToSign     = ['AWS4-HMAC-SHA256', date, credentialScope, hash(canonicalRequest, 'hex')].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac('AWS4' + secretKey, dateStamp), region), service),
    'aws4_request'
  );
  const signature = hmac(signingKey, stringToSign, 'hex');

  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function r2Request(method, accountId, accessKeyId, secretKey, bucket, key, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
    const url      = `${endpoint}/${bucket}/${key}`;
    const now      = new Date();
    const amzDate  = now.toISOString().replace(/[:-]|\.\d{3}/g, '').substring(0, 15) + 'Z';
    const parsed   = new URL(url);

    const headers = {
      'Host':                  parsed.hostname,
      'x-amz-date':           amzDate,
      'x-amz-content-sha256': hash(body || '', 'hex'),
      ...extraHeaders
    };

    if (body) headers['Content-Length'] = Buffer.byteLength(body).toString();
    headers['Authorization'] = signV4(method, url, headers, body, accessKeyId, secretKey, 'auto', 's3', amzDate);

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

async function getR2File(accountId, accessKeyId, secretKey, bucket, key) {
  if (!accountId || !accessKeyId || !secretKey || !bucket) return null;
  const res = await r2Request('GET', accountId, accessKeyId, secretKey, bucket, key, null, {});
  if (res.status !== 200) return null;
  return res.body;
}
