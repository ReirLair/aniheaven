const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { executablePath } = require('puppeteer');
const axios = require('axios');
const qs = require('qs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
const PORT = 7860;
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/video', async (req, res) => {
    const searchQuery = req.query.name;
    const episodeParam = parseInt(req.query.episode);

    if (!searchQuery || isNaN(episodeParam)) {
        return res.status(400).json({ error: 'Missing or invalid query parameters: name and episode' });
    }

    let browser;
    try {
        browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();

        await page.setUserAgent('Mozilla/5.0');
        await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });

        // Step 1: Search for anime
        const searchUrl = `https://animeheaven.me/search.php?s=${encodeURIComponent(searchQuery)}`;
        await page.goto(searchUrl, { waitUntil: 'networkidle2' });

        const firstAnimeLink = await page.evaluate(() => {
            const aTags = Array.from(document.querySelectorAll('a'));
            const target = aTags.find(a => a.href.includes('anime.php?'));
            return target ? target.href : null;
        });

        if (!firstAnimeLink) {
            await browser.close();
            return res.status(404).json({ error: 'Anime not found' });
        }

        // Step 2: Visit anime page
        await page.goto(firstAnimeLink, { waitUntil: 'networkidle2' });

        const episodeMap = await page.evaluate(() => {
            const items = [];
            const anchors = document.querySelectorAll('a');
            anchors.forEach(a => {
                const href = a.href;
                if (href.includes('episode.php?')) {
                    const text = a.innerText || a.textContent;
                    const match = text.match(/Episode\s*(\d+)/i);
                    if (match) {
                        items.push({ number: parseInt(match[1]), url: href });
                    }
                }
            });
            return items;
        });

        const targetEpisode = episodeMap.find(e => e.number === episodeParam);
        if (!targetEpisode) {
            await browser.close();
            return res.status(404).json({ error: `Episode ${episodeParam} not found` });
        }

        // Step 3: Monitor for .mp4 response
        let videoUrl = null;
        page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('.mp4') && !videoUrl) {
                videoUrl = url;
            }
        });

        // Step 4: Visit episode page and wait for video element
        await page.goto(targetEpisode.url, { waitUntil: 'networkidle2' });
        await page.waitForSelector('video, iframe', { timeout: 10000 }).catch(() => {});

        // Step 5: Extract episode number from page (optional)
        const pageEpisode = await page.evaluate(() => {
            const episodeText = document.body.innerText.match(/Episode\s*(\d+)/i);
            return episodeText ? parseInt(episodeText[1]) : null;
        });

        await browser.close();

        if (videoUrl) {
            return res.json({
                animeName: searchQuery,
                episodeNumber: pageEpisode || episodeParam,
                videoUrl
            });
        } else {
            return res.status(404).json({ error: 'Video URL not found' });
        }

    } catch (err) {
        if (browser) await browser.close();
        console.error(err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/iframe', async (req, res) => {
  const episodeUrl = req.query.url;

  if (!episodeUrl) {
    return res.status(400).json({ error: 'Missing "url" query parameter' });
  }

  try {
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();

    await page.goto(episodeUrl, { waitUntil: 'load' });

    // Wait for iframe(s) to load
    await new Promise(resolve => setTimeout(resolve, 7000));

    const iframeSrc = await page.evaluate(() => {
      const iframes = document.querySelectorAll('iframe');
      for (let iframe of iframes) {
        const style = window.getComputedStyle(iframe);
        if (style.display !== 'none' && iframe.src) {
          return iframe.src;
        }
      }
      return null;
    });

    await browser.close();

    if (iframeSrc) {
      res.json({ iframeUrl: iframeSrc });
    } else {
      res.status(404).json({ error: 'No visible iframe found' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to process URL', details: error.message });
  }
});

const urlMap = new Map();

app.get('/vid/:id', (req, res) => {
  const originalUrl = urlMap.get(req.params.id);

  if (!originalUrl) {
    return res.status(404).json({ error: 'URL not found.' });
  }

  res.redirect(originalUrl);
});

app.get('/q', (req, res) => {
  const inputUrl = req.query.q;

  if (!inputUrl) {
    return res.status(400).json({ error: 'Missing URL.' });
  }

  // Generate a random 16-character hex path
  const randomPath = crypto.randomBytes(8).toString('hex');

  urlMap.set(randomPath, inputUrl);
  const fullUrl = `${req.protocol}://${req.get('host')}/vid/${randomPath}`;

  res.json({ url: fullUrl });
});

app.get('/ytdl', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url query parameter' });

  try {
    const response = await axios.post('https://www.clipto.com/api/youtube', { url }, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Content-Type': 'application/json'
      }
    });

    const data = response.data;

    const result = {
      title: data.title,
      thumbnail: data.thumbnail,
      mp4: data.medias
        .filter(m => m.ext === 'mp4')
        .map(m => ({
          quality: m.quality || 'unknown',
          url: m.url
        })),
      audio: data.medias
        .filter(m => m.type === 'audio' && ['m4a', 'opus'].includes(m.ext))
        .map(m => ({
          quality: m.quality || 'unknown',
          url: m.url
        }))
    };

    res.json(result);
  } catch (error) {
    console.error('Error fetching video info:', error.message);
    res.status(500).json({ error: 'Failed to fetch video info' });
  }
});

app.get('/api/download-links', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing URL parameter' });
  }

  try {
    const browser = await puppeteer.launch({
      headless: 'new',
      executablePath: executablePath(),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--window-size=1920,1080',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ],
      ignoreHTTPSErrors: true,
      defaultViewport: null
    });

    const page = await browser.newPage();

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'accept-language': 'en-US,en;q=0.9',
      'upgrade-insecure-requests': '1',
      'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"'
    });

    await page.setViewport({
      width: 1920 + Math.floor(Math.random() * 100),
      height: 1080 + Math.floor(Math.random() * 100),
      deviceScaleFactor: 1,
      hasTouch: false,
      isLandscape: false,
      isMobile: false
    });

    // Enable request interception (optional)
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = request.url();
      const resourceType = request.resourceType();

      if (
        ['image', 'font', 'stylesheet', 'media', 'other', 'xhr', 'script'].includes(resourceType) &&
        !url.includes('9anime')
      ) {
        request.abort();
      } else {
        request.continue();
      }
    });

    console.log(`Navigating to: ${url}`);
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    console.log('Clicking download button...');
    await page.waitForSelector('#download-btn', { timeout: 30000 });
    await page.click('#download-btn');

    console.log('Waiting for modal to load...');
    await page.waitForSelector('#downloadModal.show', { timeout: 30000 });
    await page.waitForResponse(response => 
      response.url().includes('admin-ajax.php') && 
      response.status() === 200
    );

    console.log('Extracting download links...');
    const links = await page.evaluate(() => {
      const result = [];
      const downloadButtons = document.querySelectorAll('#download-links a.btn.btn-primary');
      
      downloadButtons.forEach(button => {
        const quality = button.textContent.trim();
        const link = button.href.trim();
        result.push({ quality, link });
      });

      return result;
    });

    await browser.close();
    res.json({ success: true, links });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

app.get('/api/anime-links', async (req, res) => {
  const rawQuery = req.query.q || 'Naruto';
  const query = rawQuery.toLowerCase().trim();
  const querySlug = query.replace(/\s+/g, '-');
  const pageUrl = `https://9anime.org.lv/?s=${encodeURIComponent(query)}`;

  try {
    const browser = await puppeteer.launch({
      headless: 'new',
      executablePath: executablePath(),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--window-size=1920,1080',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ],
      ignoreHTTPSErrors: true,
      defaultViewport: null
    });

    const page = await browser.newPage();

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'accept-language': 'en-US,en;q=0.9'
    });

    await page.setViewport({ width: 1920, height: 1080 });

    console.log(`Navigating to: ${pageUrl}`);
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    await delay(1000); // Wait for content to load

    const links = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll('a[href^="https://9anime.org.lv/anime/"]'));
      const seen = new Set();
      return anchors.map(a => {
        const href = a.href.split('?')[0];
        if (!seen.has(href) && /^https:\/\/9anime\.org\.lv\/anime\/[^/]+\/?$/.test(href)) {
          seen.add(href);
          return href;
        }
      }).filter(Boolean);
    });

    await browser.close();

    const filtered = links.filter(link => !/\/anime\/.*-movie/.test(link));

    if (!filtered.length) {
      return res.status(404).json({ success: false, message: 'No valid anime links found' });
    }

    const scored = filtered.map(link => {
      const slug = link.split('/anime/')[1].replace(/\/$/, '').toLowerCase();
      let score = 0;
      if (slug === querySlug) score = 3;
      else if (slug.startsWith(querySlug)) score = 2;
      else if (slug.includes(querySlug)) score = 1;
      return { link, slug, score };
    });

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.slug.length - b.slug.length;
    });

    const bestMatch = scored.find(item => item.score > 0);

    if (!bestMatch) {
      return res.status(404).json({ success: false, message: 'No suitable match found' });
    }

    res.json({
      success: true,
      bestMatch: bestMatch.link
    });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/anime-download', async (req, res) => {
    const { q, episode } = req.query;

    if (!q || !episode) {
        return res.status(400).json({ success: false, message: "Missing 'q' (anime name) or 'episode'" });
    }

    try {
        // Step 1: Get best match URL
        const searchRes = await axios.get(`https://txtorg-anih.hf.space/api/anime-links?q=${encodeURIComponent(q)}`);
        const bestMatch = searchRes.data.bestMatch;

        if (!bestMatch) {
            return res.status(404).json({ success: false, message: 'Anime not found' });
        }

        // Step 2: Remove /anime/ from the path
        const urlObj = new URL(bestMatch);
urlObj.pathname = urlObj.pathname.replace('/anime/', '/').replace(/\/$/, '');

const cleanedUrl = `${urlObj.origin}${urlObj.pathname}`;
const modifiedUrl = `${cleanedUrl}-episode-${episode}/`;

        // Step 3: Get download links
        const downloadRes = await axios.get(`https://txtorg-anih.hf.space/api/download-links?url=${encodeURIComponent(modifiedUrl)}`);

        return res.json({
            success: true,
            anime: q,
            episode: episode,
            stream_url: modifiedUrl,
            download_links: downloadRes.data.links
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: 'Server error', error: error.message });
    }
});

app.get('/resolve', async (req, res) => {
  const inputUrl = req.query.url;
  if (!inputUrl) return res.status(400).json({ error: 'Missing ?url parameter' });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    let directFileUrl = null;

    page.on('response', async (response) => {
      const url = response.url();

      if (
        url.match(/\.(mp4|mkv|mov)(\?|$)/i) ||
        url.includes('nextcdn') ||
        url.includes('vault-13.kwik.cx')
      ) {
        if (!directFileUrl) {
          directFileUrl = url;
          console.log('[FOUND]', directFileUrl);
        }
      }
    });

    await page.goto(inputUrl, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    await browser.close();

    if (directFileUrl) {
      res.json({ success: true, resolvedUrl: directFileUrl });
    } else {
      res.status(404).json({ error: 'No direct file URL found after redirects' });
    }

  } catch (err) {
    if (browser) await browser.close();
    res.status(500).json({ error: 'Failed to resolve URL', details: err.toString() });
  }
});

function similarity(s1, s2) {
  s1 = s1.toLowerCase();
  s2 = s2.toLowerCase();
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  const longerLength = longer.length;
  if (longerLength === 0) return 1.0;
  return (longerLength - editDistance(longer, shorter)) / parseFloat(longerLength);
}

function editDistance(s1, s2) {
  const costs = [];
  for (let i = 0; i <= s1.length; i++) {
    let lastValue = i;
    for (let j = 0; j <= s2.length; j++) {
      if (i === 0) {
        costs[j] = j;
      } else if (j > 0) {
        let newValue = costs[j - 1];
        if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
          newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
        }
        costs[j - 1] = lastValue;
        lastValue = newValue;
      }
    }
    if (i > 0) costs[s2.length] = lastValue;
  }
  return costs[s2.length];
}

// Auto-scroll helper
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let totalHeight = 0;
      const distance = 300;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight - window.innerHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
    });
  });
}

// Express API Route
app.get('/api/episode', async (req, res) => {
  const animeQuery = req.query.anime;
  const episodeQuery = parseInt(req.query.ep);

  if (!animeQuery || isNaN(episodeQuery)) {
    return res.status(400).json({ error: 'anime and ep query parameters are required' });
  }

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto('https://animepahe.ru/anime', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.tab-content .tab-pane');
    await autoScroll(page);

    // Get all anime entries
    const results = await page.evaluate(() => {
      const allAnime = [];
      const panes = document.querySelectorAll('.tab-content .tab-pane');
      panes.forEach(pane => {
        const items = pane.querySelectorAll('.col-12.col-md-6 a');
        items.forEach(a => {
          const title = a.getAttribute('title');
          const link = a.getAttribute('href');
          if (title && link) allAnime.push({ title, link });
        });
      });
      return allAnime;
    });

    // Find best match
    let bestMatch = null;
    let bestScore = 0;
    for (const anime of results) {
      const score = similarity(animeQuery, anime.title);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = anime;
      }
    }

    if (!bestMatch || bestScore < 0.3) {
      await browser.close();
      return res.status(404).json({ error: 'No matching anime found.' });
    }

    const animePageUrl = `https://animepahe.ru${bestMatch.link}`;
    await page.goto(animePageUrl, { waitUntil: 'domcontentloaded' });

    const animeId = await page.evaluate(() => {
      const meta = document.querySelector('meta[property="og:url"]');
      return meta ? meta.content.split('/').pop() : null;
    });

    if (!animeId) throw new Error('Failed to extract anime ID');

    // Search for episode
    let found = null;
    for (let pageNum = 1; pageNum <= 50; pageNum++) {
      const data = await page.evaluate(async (animeId, pageNum) => {
        const apiUrl = `https://animepahe.ru/api?m=release&id=${animeId}&page=${pageNum}&sort=episode_asc`;
        const res = await fetch(apiUrl);
        if (!res.ok) return null;
        return await res.json();
      }, animeId, pageNum);

      if (!data || !data.data) continue;

      const match = data.data.find(ep => ep.episode == episodeQuery || ep.number == episodeQuery);
      if (match) {
        found = {
          episode: match.episode,
          snapshot: match.snapshot.replace(/\\\//g, '/'),
          session: match.session
        };
        break;
      }
    }

    if (!found) {
      await browser.close();
      return res.status(404).json({ error: `Episode ${episodeQuery} not found.` });
    }

    const playUrl = `https://animepahe.ru/play/${animeId}/${found.session}`;

    // Go to play page
    const playPage = await browser.newPage();
    await playPage.goto(playUrl, { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 5000));

    // Extract and map links by quality
    const links = await playPage.evaluate(() => {
      const map = {};
      const anchors = Array.from(document.querySelectorAll('a[href*="pahe.win"]'));
      anchors.forEach(a => {
        const text = a.innerText.trim().toLowerCase();
        const href = a.href;
        if (text.includes('360')) map['360p'] = href;
        else if (text.includes('480')) map['480p'] = href;
        else if (text.includes('720')) map['720p'] = href;
        else if (text.includes('1080')) map['1080p'] = href;
        else map[text] = href;
      });
      return map;
    });

    await playPage.close();
    await browser.close();

    return res.json({
      title: bestMatch.title,
      episode: found.episode,
      snapshot: found.snapshot,
      playUrl,
      paheLinks: links
    });

  } catch (err) {
    await browser.close();
    return res.status(500).json({ error: err.message });
  }
});

app.get('/pahe', async (req, res) => {
  const inputUrl = req.query.url;
  if (!inputUrl) return res.status(400).json({ error: 'Missing ?url parameter' });

  const match = inputUrl.match(/pahe\.win\/([^\/\?\s]+)/i);
  if (!match || !match[1]) {
    return res.status(400).json({ error: 'Invalid pahe.win URL' });
  }

  const slug = match[1];
  const targetUrl = `https://pahe.bunniescdn.online/${slug}`;

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    let directFileUrl = null;

    page.on('response', async (response) => {
      const url = response.url();
      if (
        url.match(/\.(mp4|mkv|mov)(\?|$)/i) ||
        url.includes('nextcdn') ||
        url.includes('vault-13.kwik.cx')
      ) {
        if (!directFileUrl) {
          directFileUrl = url;
          console.log('[FOUND]', directFileUrl);
        }
      }
    });

    await page.goto(targetUrl, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    await browser.close();

    if (directFileUrl) {
      res.json({ success: true, resolvedUrl: directFileUrl });
    } else {
      res.status(404).json({ error: 'No direct file URL found after redirects' });
    }

  } catch (err) {
    if (browser) await browser.close();
    res.status(500).json({ error: 'Failed to resolve URL', details: err.toString() });
  }
});

const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 10; SM-G981B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36'
];

const getRandomUserAgent = () => userAgents[Math.floor(Math.random() * userAgents.length)];

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const getRandomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

app.get('/spotify', async (req, res) => {
  const spotifyUrl = req.query.url;
  if (!spotifyUrl) {
    return res.status(400).json({ error: 'Missing Spotify URL in query.' });
  }

  try {
    // Generate unique session identifiers
    const fingerprint = Math.floor(Math.random() * 2000000000) - 1000000000;
    const sessionId = crypto.randomBytes(16).toString('hex');
    const days = Math.random().toFixed(6);
    const userAgent = getRandomUserAgent();

    // Common headers configuration
    const baseHeaders = {
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': userAgent,
      'Origin': 'https://spotisongdownloader.to',
      'Referer': 'https://spotisongdownloader.to/',
      'Cookie': `PHPSESSID=${sessionId}; fp=${fingerprint}`,
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin'
    };

    // Step 0: Verify fingerprint with random delay
    await delay(getRandomDelay(500, 1500));
    
    const verifyResponse = await axios.post(
      'https://spotisongdownloader.to/users/fingerprints.php',
      qs.stringify({
        action: 'verify',
        fp: fingerprint,
        days: days
      }),
      {
        headers: {
          ...baseHeaders,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
        },
        timeout: 10000
      }
    ).catch(err => {
      console.error('Fingerprint verification failed:', err.message);
      // Continue anyway as this might not be critical
    });

    // Step 1: Fetch track metadata with delay
    await delay(getRandomDelay(800, 2000));
    
    const firstApi = `https://spotisongdownloader.to/api/composer/spotify/xsingle_track.php?url=${encodeURIComponent(spotifyUrl)}`;
    const { data: meta } = await axios.get(firstApi, {
      headers: baseHeaders,
      timeout: 15000
    });

    if (!meta?.song_name || !meta?.artist || !meta?.url) {
      // Retry once with new session if metadata is invalid
      await delay(getRandomDelay(1000, 3000));
      const retryMeta = await axios.get(firstApi, {
        headers: {
          ...baseHeaders,
          'User-Agent': getRandomUserAgent() // Rotate UA on retry
        },
        timeout: 15000
      }).catch(() => null);
      
      if (!retryMeta?.data?.song_name) {
        return res.status(500).json({ 
          error: 'Invalid metadata received',
          details: meta
        });
      }
      meta = retryMeta.data;
    }

    // Step 2: Prepare POST data with delay
    await delay(getRandomDelay(1000, 2500));
    
    const postData = qs.stringify({
      song_name: meta.song_name,
      artist_name: meta.artist,
      url: meta.url
    });

    // Step 3: Send POST request with all required headers
    const { data: downloadData } = await axios.post(
      'https://spotisongdownloader.to/api/composer/spotify/ssdw23456ytrfds.php',
      postData,
      {
        headers: {
          ...baseHeaders,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Accept-Encoding': 'gzip, deflate, br'
        },
        timeout: 20000
      }
    ).catch(async err => {
      // If we get 403, wait longer and retry once
      if (err.response?.status === 403) {
        await delay(getRandomDelay(3000, 5000));
        return axios.post(
          'https://spotisongdownloader.to/api/composer/spotify/ssdw23456ytrfds.php',
          postData,
          {
            headers: {
              ...baseHeaders,
              'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
              'User-Agent': getRandomUserAgent() // Rotate UA on retry
            },
            timeout: 20000
          }
        );
      }
      throw err;
    });

    if (!downloadData?.dlink) {
      return res.status(403).json({ 
        error: '403 Forbidden or no download link',
        details: downloadData?.message || 'No error message provided',
        response: downloadData
      });
    }

    // Optional completion log with delay
    await delay(getRandomDelay(500, 1500));
    await axios.get(`https://spotisongdownloader.to/log.php?t=${Date.now()}&status=finished with m4a&error=Spotify`, {
      headers: baseHeaders
    }).catch(() => null); // Ignore errors in logging

    res.json({
      meta,
      download: downloadData.dlink
    });

  } catch (err) {
    console.error('Error:', err.response?.data || err.message);
    
    const errorResponse = {
      error: 'Failed to fetch data',
      details: err.message,
      status: err.response?.status,
      data: err.response?.data,
      suggestion: 'Try again in a few seconds'
    };
    
    res.status(500).json(errorResponse);
  }
});
app.get('/deezer', async (req, res) => {
  const query = req.query.q;

  if (!query) {
    return res.status(400).json({ error: 'Missing ?q=song name in query' });
  }

  try {
    // Step 1: Search Deezer
    const searchRes = await axios.get(`https://api.deezer.com/search?q=${encodeURIComponent(query)}`);
    const data = searchRes.data;

    if (!data.data || data.data.length === 0) {
      return res.status(404).json({ error: 'No results found' });
    }

    const track = data.data[0];
    const trackId = track.id;

    const trackInfo = {
      title: track.title,
      artist: track.artist.name,
      album: track.album.title,
      deezerLink: track.link,
      preview: track.preview,
      thumbnail: track.album.cover_medium
    };

    // Step 2: Get download links from Deezmate
    const dlRes = await axios.get(`https://api.deezmate.com/dl/${trackId}`);
    const dlData = dlRes.data;

    if (!dlData.success) {
      return res.status(404).json({ error: 'Download links not available' });
    }

    // Combine and send all info
    return res.json({
      ...trackInfo,
      downloads: {
        mp3: dlData.links.mp3,
        flac: dlData.links.flac
      }
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
});

async function sendMessage(message, chatId) {
  const url = 'https://chatfreeai.com/wp-admin/admin-ajax.php';

  const params = new URLSearchParams();
  params.append('_wpnonce', 'd0bfe9bf42');
  params.append('post_id', '10');
  params.append('url', 'https://chatfreeai.com');
  params.append('action', 'wpaicg_chat_shortcode_message');
  params.append('message', message);
  params.append('bot_id', '0');
  params.append('chatbot_identity', 'shortcode');
  params.append('wpaicg_chat_history', '[]');
  params.append('wpaicg_chat_client_id', 'uL7gDcdTME');
  params.append('chat_id', chatId);

  const response = await axios({
    method: 'POST',
    url,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    data: params.toString(),
    responseType: 'stream',
  });

  const reader = response.data;
  const decoder = new TextDecoder('utf-8');

  let buffer = '';
  let fullMessage = '';

  for await (const chunk of reader) {
    buffer += decoder.decode(chunk, { stream: true });

    const lines = buffer.split('\n');
    for (let line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const json = JSON.parse(line.slice(6));
          const content = json.choices?.[0]?.delta?.content;
          if (content) {
            fullMessage += content;
          }
        } catch (e) {
          // Ignore malformed lines
        }
      }
    }

    buffer = lines[lines.length - 1];
  }

  return fullMessage;
}

app.get('/gpt', async (req, res) => {
  const { message, chat_id } = req.query;

  if (!message || !chat_id) {
    return res.status(400).json({ error: 'Missing message or chat_id' });
  }

  if (!/^\d{6}$/.test(chat_id)) {
    return res.status(400).json({ error: 'chat_id must be exactly 6 digits' });
  }

  try {
    const reply = await sendMessage(message, chat_id);
    res.json({
      response: reply,
      creator: 'Reiker',
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      error: 'Failed to get response from chat bot',
      creator: 'Reiker',
    });
  }
});

async function sendToDeepseek(message, chatId) {
  const url = 'https://chatfreeai.com/wp-admin/admin-ajax.php';

  const chatHistory = [
    { id: '', text: 'Human: Yo' },
    {
      id: 2125,
      text:
        'AI: Hey! 👋 Thanks for reaching out. As of today (May 18, 2025), **DeepSeek AI** is a totally free, unlimited platform offering AI tools and chatbots to help with tasks like writing, coding, research, and productivity. It’s designed to break cost barriers, making advanced AI accessible to everyone—students, small businesses, or casual users. You can tap into features like real-time assistance, smart automation, and learning support without spending a dime. Need help drafting an essay, debugging code, or organizing your workflow? DeepSeek’s got your back! 😊',
    },
  ];

  const params = new URLSearchParams();
  params.append('_wpnonce', 'd0bfe9bf42');
  params.append('post_id', '77');
  params.append('url', 'https://chatfreeai.com/deepseek-ai-unlimited-free');
  params.append('action', 'wpaicg_chat_shortcode_message');
  params.append('message', message);
  params.append('bot_id', '68');
  params.append('chatbot_identity', 'custom_bot_68');
  params.append('wpaicg_chat_history', JSON.stringify(chatHistory));
  params.append('wpaicg_chat_client_id', 'uL7gDcdTME');
  params.append('chat_id', chatId);

  const response = await axios({
    method: 'POST',
    url,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    data: params.toString(),
    responseType: 'stream',
  });

  const reader = response.data;
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let fullMessage = '';

  for await (const chunk of reader) {
    buffer += decoder.decode(chunk, { stream: true });

    const lines = buffer.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const json = JSON.parse(line.slice(6));
          const reasoning = json.choices?.[0]?.delta?.reasoning;
          if (reasoning) {
            fullMessage += reasoning;
          }
        } catch (e) {
          // Ignore parsing errors
        }
      }
    }

    buffer = lines[lines.length - 1]; // Keep last line if partial
  }

  return fullMessage;
}

app.get('/deepseek', async (req, res) => {
  const { message, chat_id } = req.query;

  if (!message || !chat_id) {
    return res.status(400).json({ error: 'Missing message or chat_id' });
  }

  if (!/^\d{6}$/.test(chat_id)) {
    return res.status(400).json({ error: 'chat_id must be exactly 6 digits' });
  }

  try {
    const reply = await sendToDeepseek(message, chat_id);
    res.json({ response: reply, creator: 'Reiker' });
  } catch (error) {
    console.error('DeepSeek Error:', error.message);
    res.status(500).json({ error: 'Failed to get DeepSeek response', creator: 'Reiker' });
  }
});

function extractPlaylistId(url) {
  // Matches both standard and shortened Spotify URLs
  const regex = /(?:spotify\.com\/playlist\/|open\.spotify\.com\/playlist\/|spotify:playlist:)([a-zA-Z0-9]+)/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

// Function to fetch playlist data and extract song details
async function getPlaylistSongs(playlistId) {
  try {
    const response = await axios.get(`https://api.trackify.am/playlist/analyse?playlist_id=${playlistId}&include_details=true`);
    const data = response.data;
    
    if (data.status === 'success') {
      return data.data.tracks.map(track => ({
        name: track.track.name,
        url: track.track.external_urls.spotify,
        artists: track.track.artists.map(artist => artist.name),
        duration_ms: track.track.duration_ms,
        album: track.track.album.name,
        album_image: track.track.album.images[0]?.url // Adding album image URL
      }));
    }
    return [];
  } catch (error) {
    console.error('Error fetching playlist:', error.message);
    return [];
  }
}

// API endpoint
app.get('/list', async (req, res) => {
  try {
    const playlistUrl = req.query.url;
    if (!playlistUrl) {
      return res.status(400).json({ error: 'Missing playlist URL in query parameters' });
    }

    const playlistId = extractPlaylistId(playlistUrl);
    if (!playlistId) {
      return res.status(400).json({ error: 'Invalid Spotify playlist URL' });
    }

    const songs = await getPlaylistSongs(playlistId);
    res.json({
      playlistId,
      songCount: songs.length,
      songs
    });
  } catch (error) {
    console.error('Error processing request:', error.message);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

const clientId = 'ae3ec3332d1b4500bbef0f6952ea6805';
const clientSecret = 'dc03110d119d40bdab1f23461e004c31';

async function getAccessToken() {
  const authString = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  try {
    const response = await axios.post('https://accounts.spotify.com/api/token', 
      'grant_type=client_credentials', 
      {
        headers: {
          'Authorization': `Basic ${authString}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        }
      }
    );
    return response.data.access_token;
  } catch (error) {
    console.error('Failed to get access token:', error.response ? error.response.data : error.message);
    throw error;
  }
}

app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'Missing query parameter q' });
  }

  try {
    const token = await getAccessToken();

    const response = await axios.get('https://api.spotify.com/v1/search', {
      params: {
        q: query,
        type: 'track',
        limit: 1,
        include_external: 'audio'
      },
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    const track = response.data.tracks.items[0];
    if (!track) {
      return res.status(404).json({ error: 'No tracks found' });
    }

    // Construct the JSON response
    const result = {
      title: track.name,
      id: track.id,
      artists: track.artists.map(a => a.name),
      album: track.album.name,
      duration_seconds: Math.floor(track.duration_ms / 1000),
      popularity: track.popularity,
      release_date: track.album.release_date,
      spotify_url: track.external_urls.spotify,
      preview_available: Boolean(track.preview_url),
      explicit: track.explicit,
      album_type: track.album.album_type,
      total_tracks_in_album: track.album.total_tracks,
      track_number: track.track_number,
      isrc: track.external_ids.isrc,
      available_markets_count: track.available_markets.length
    };

    res.json(result);

  } catch (error) {
    console.error('Error fetching track:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Failed to fetch track' });
  }
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

