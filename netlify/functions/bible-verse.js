/**
 * MAVEL'S CORNER — BIBLE VERSE FUNCTION
 * File: netlify/functions/bible-verse.js
 *
 * Called by the Bible reader screen in the app when NKJV, NLT, or
 * Amplified is selected as the translation.
 *
 * 1. Looks up the correct API.Bible "bible id" for the requested
 *    translation (cached after the first lookup, so it isn't repeated
 *    on every request).
 * 2. Fetches the requested chapter from API.Bible.
 * 3. Splits the returned text into an array of individual verses.
 * 4. Returns that array as JSON.
 *
 * If anything fails (translation not found, API.Bible limit reached,
 * network error), this returns a non-200 status. The app is built to
 * silently fall back to KJV whenever that happens, so the reader
 * never sees an error.
 *
 * Environment variable required (set in Netlify dashboard):
 *   API_BIBLE_KEY — your API.Bible API key
 *
 * Example call from the app:
 *   /.netlify/functions/bible-verse?translation=NKJV&book=JHN&chapter=3
 */

const https = require('https');

/* ── CORS HEADERS ── */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS'
};

// Official abbreviations API.Bible uses for each translation we support.
const TRANSLATION_ABBREVIATIONS = {
  NKJV: 'NKJV',
  NLT: 'NLT',
  AMP: 'AMP'
};

// Cache resolved bible IDs in memory for the lifetime of this function
// instance, so we don't call /bibles on every single request.
let bibleIdCache = {};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: CORS, body: 'Method not allowed' };
  }

  const { translation, book, chapter } = event.queryStringParameters || {};

  if (!translation || !book || !chapter) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: 'Missing translation, book, or chapter' })
    };
  }

  const abbreviation = TRANSLATION_ABBREVIATIONS[translation.toUpperCase()];
  if (!abbreviation) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: 'Unsupported translation: ' + translation })
    };
  }

  const { API_BIBLE_KEY } = process.env;
  if (!API_BIBLE_KEY) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'API_BIBLE_KEY not configured' })
    };
  }

  try {
    const bibleId = await getBibleId(abbreviation, API_BIBLE_KEY);
    if (!bibleId) {
      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({ error: 'Translation not found in this account: ' + abbreviation })
      };
    }

    const chapterId = book.toUpperCase() + '.' + chapter;
    const verses = await getChapterVerses(bibleId, chapterId, API_BIBLE_KEY);

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ verses })
    };
  } catch (e) {
    console.error('bible-verse error:', e.message);
    return {
      statusCode: 502,
      headers: CORS,
      body: JSON.stringify({ error: e.message })
    };
  }
};

/* ════════════════════════════════════════════════
   RESOLVE BIBLE ID FROM ABBREVIATION
════════════════════════════════════════════════ */
async function getBibleId(abbreviation, apiKey) {
  if (bibleIdCache[abbreviation]) {
    return bibleIdCache[abbreviation];
  }

  const data = await apiBibleRequest('/v1/bibles', apiKey);
  const match = (data.data || []).find(
    (b) => (b.abbreviationLocal || b.abbreviation || '').toUpperCase() === abbreviation
  );

  if (match) {
    bibleIdCache[abbreviation] = match.id;
    return match.id;
  }
  return null;
}

/* ════════════════════════════════════════════════
   FETCH A CHAPTER AND SPLIT INTO VERSES
════════════════════════════════════════════════ */
async function getChapterVerses(bibleId, chapterId, apiKey) {
  const path =
    '/v1/bibles/' + bibleId + '/chapters/' + chapterId +
    '?content-type=text&include-notes=false&include-titles=false' +
    '&include-chapter-numbers=false&include-verse-numbers=true&include-verse-spans=false';

  const data = await apiBibleRequest(path, apiKey);
  const rawContent = (data.data && data.data.content) || '';

  return splitIntoVerses(rawContent);
}

function splitIntoVerses(rawContent) {
  // API.Bible returns verse numbers wrapped in square brackets, e.g.
  // "[1] In the beginning God created... [2] And the earth was..."
  const parts = rawContent.split(/\[(\d+)\]/).map((s) => s.trim()).filter(Boolean);

  const verses = [];
  for (let i = 0; i < parts.length; i++) {
    if (/^\d+$/.test(parts[i])) continue;
    verses.push(parts[i].replace(/\s+/g, ' ').trim());
  }

  // Fallback: if the bracket pattern didn't match (format changed),
  // return the whole chapter as one block rather than nothing.
  return verses.length > 0 ? verses : [rawContent.replace(/\s+/g, ' ').trim()];
}

/* ════════════════════════════════════════════════
   API.BIBLE HTTPS REQUEST HELPER
════════════════════════════════════════════════ */
function apiBibleRequest(path, apiKey) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'rest.api.bible',
      path: path,
      method: 'GET',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error('API.Bible ' + res.statusCode + ': ' + data));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Failed to parse API.Bible response'));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}