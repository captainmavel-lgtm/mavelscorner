/**
 * MAVEL'S CORNER — BIBLE VERSE FUNCTION
 * File: netlify/functions/bible-verse.js
 *
 * Called by the Bible reader screen in the app when NKJV, NLT, or
 * Amplified is selected as the translation.
 *
 * 1. Looks up the correct API.Bible "bible id" for the requested
 *    translation (cached after the first lookup).
 * 2. Fetches the requested chapter from API.Bible as HTML, which is
 *    the only format that carries section headings and "words of
 *    Jesus" (red-letter) markup.
 * 3. Parses that HTML into an ordered list of "blocks": headings and
 *    verses, where each verse is broken into text segments flagged
 *    as either normal text or words of Jesus.
 * 4. Returns those blocks as JSON.
 *
 * If anything fails (translation not found, API.Bible limit reached,
 * network error, no usable content), this returns a non-200 status.
 * The app silently falls back to KJV whenever that happens.
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

const TRANSLATION_ABBREVIATIONS = {
  NKJV: 'NKJV',
  NLT: 'NLT',
  AMP: 'AMP'
};

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
    const blocks = await getChapterBlocks(bibleId, chapterId, API_BIBLE_KEY);

    if (!blocks || blocks.length === 0) {
      return {
        statusCode: 502,
        headers: CORS,
        body: JSON.stringify({ error: 'No content returned for this chapter' })
      };
    }

    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks })
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
   FETCH A CHAPTER AS HTML AND PARSE IT
════════════════════════════════════════════════ */
async function getChapterBlocks(bibleId, chapterId, apiKey) {
  const path =
    '/v1/bibles/' + bibleId + '/chapters/' + chapterId +
    '?content-type=html&include-notes=false&include-titles=true' +
    '&include-chapter-numbers=false&include-verse-numbers=true&include-verse-spans=false';

  const data = await apiBibleRequest(path, apiKey);
  const rawHtml = (data.data && data.data.content) || '';

  return parseChapterHTML(rawHtml);
}

// Splits chapter HTML into an ordered array of blocks:
//   { type: 'heading', text }
//   { type: 'verse', number, segments: [{ text, isWordsOfJesus }] }
//
// Looks for the standard USX-derived class names Bible content APIs use:
//   class="s1" / "s2"  — section headings
//   class="v"          — verse number marker (with a data-number attribute)
//   class="wj"         — words of Jesus
function parseChapterHTML(html) {
  const blocks = [];
  let currentVerse = null;
  let headingBuffer = null;
  let inVerseNumberSpan = false;
  let inWJ = false;
  let buffer = '';

  function flushBuffer() {
    if (buffer.length === 0) return;
    if (currentVerse) {
      currentVerse.segments.push({ text: buffer, isWordsOfJesus: inWJ });
    }
    buffer = '';
  }

  function endVerse() {
    flushBuffer();
    if (currentVerse && currentVerse.segments.length > 0) {
      blocks.push(currentVerse);
    }
    currentVerse = null;
  }

  const tagRegex = /<[^>]+>/g;
  let lastIndex = 0;
  let match;
  const tokens = [];
  while ((match = tagRegex.exec(html)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', value: html.slice(lastIndex, match.index) });
    }
    tokens.push({ type: 'tag', value: match[0] });
    lastIndex = tagRegex.lastIndex;
  }
  if (lastIndex < html.length) {
    tokens.push({ type: 'text', value: html.slice(lastIndex) });
  }

  for (const token of tokens) {
    if (token.type === 'text') {
      const decoded = decodeHtmlEntities(token.value);
      if (headingBuffer !== null) {
        headingBuffer += decoded;
      } else if (!inVerseNumberSpan) {
        buffer += decoded;
      }
      continue;
    }

    const tag = token.value;

    if (/^<p[^>]*class="s\d"/i.test(tag)) {
      endVerse();
      headingBuffer = '';
      continue;
    }
    if (headingBuffer !== null && /^<\/p>/i.test(tag)) {
      const text = headingBuffer.replace(/\s+/g, ' ').trim();
      if (text) blocks.push({ type: 'heading', text });
      headingBuffer = null;
      continue;
    }
    if (headingBuffer !== null) {
      continue;
    }

    const verseMatch = tag.match(/^<span[^>]*class="v"[^>]*data-number="(\d+)"/i);
    if (verseMatch) {
      endVerse();
      currentVerse = { type: 'verse', number: parseInt(verseMatch[1], 10), segments: [] };
      buffer = '';
      inVerseNumberSpan = true;
      continue;
    }

    if (/^<span[^>]*class="wj"/i.test(tag)) {
      flushBuffer();
      inWJ = true;
      continue;
    }

    if (/^<\/span>/i.test(tag)) {
      if (inVerseNumberSpan) {
        buffer = '';
        inVerseNumberSpan = false;
      } else {
        flushBuffer();
        inWJ = false;
      }
      continue;
    }

    flushBuffer();
    buffer = ' ';
  }

  endVerse();

  // Fallback: if nothing parsed at all (format didn't match what we
  // expected), strip every tag and return the whole chapter as one
  // unmarked block, rather than nothing.
  if (blocks.length === 0) {
    const plain = decodeHtmlEntities(html.replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    if (plain) {
      blocks.push({ type: 'verse', number: 1, segments: [{ text: plain, isWordsOfJesus: false }] });
    }
  }

  return blocks;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
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