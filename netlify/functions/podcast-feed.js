/**
 * MAVEL'S CORNER — PODCAST RSS FEED
 * File: netlify/functions/podcast-feed.js
 *
 * Generates a valid RSS 2.0 podcast feed from your published posts.
 * Each post that has a generated MP3 in R2 appears as a podcast episode.
 *
 * Access at: https://mavelscorner.blog/.netlify/functions/podcast-feed
 * Submit this URL to Spotify, Apple Podcasts, and YouTube Music.
 *
 * Environment variables required:
 *   R2_PUBLIC_URL   — https://pub-xxx.r2.dev
 *   SITE_URL        — https://mavelscorner.blog
 */

exports.handler = async function (event) {
  const SITE_URL   = process.env.SITE_URL   || 'https://mavelscorner.blog';
  const R2_PUBLIC  = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');

  /* ── PODCAST METADATA ── */
  const podcast = {
    title:       "Mavel's Corner",
    description: "A faith-based podcast for young adults and millennials exploring hope, Scripture, and the beauty of second chances. New episodes with every post from mavelscorner.blog",
    link:        SITE_URL,
    language:    'en',
    author:      'Emmanuel, Mavel\'s Corner',
    email:       'mavelscorner@outlook.com',
    category:    'Religion &amp; Spirituality',
    subcategory: 'Christianity',
    image:       SITE_URL + '/images/podcast-cover.jpg',
    explicit:    'false'
  };

  /* ── FETCH POSTS FROM SITE ── */
  // We fetch the sitemap or a JSON feed to get post data.
  // Eleventy generates posts at /blog/[slug]/index.html
  // We use a static posts.json file that we generate at build time.
  let posts = [];
  try {
    const postsUrl = SITE_URL + '/posts.json';
    posts = await fetchJSON(postsUrl);
  } catch (e) {
    // If posts.json not available, return empty feed
    posts = [];
  }

  /* ── BUILD RSS ITEMS ── */
  const items = posts
    .filter(p => p.audioUrl || (R2_PUBLIC && p.slug))
    .map(p => {
      const audioUrl   = p.audioUrl || (R2_PUBLIC + '/' + p.slug + '--en-ca-claraNeural.mp3');
      const pubDate    = new Date(p.date).toUTCString();
      const postUrl    = SITE_URL + '/blog/' + p.slug + '/';
      const duration   = p.audioDuration || '00:00';
      const fileSize   = p.audioSize || '0';

      return `
    <item>
      <title>${escapeXml(p.title)}</title>
      <link>${postUrl}</link>
      <guid isPermaLink="true">${postUrl}</guid>
      <description>${escapeXml(p.excerpt || p.title)}</description>
      <pubDate>${pubDate}</pubDate>
      <enclosure url="${audioUrl}" length="${fileSize}" type="audio/mpeg"/>
      <itunes:title>${escapeXml(p.title)}</itunes:title>
      <itunes:author>Emmanuel, Mavel's Corner</itunes:author>
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
  xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${podcast.title}</title>
    <link>${podcast.link}</link>
    <description>${podcast.description}</description>
    <language>${podcast.language}</language>
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

function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');
}

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
