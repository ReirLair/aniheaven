const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { executablePath } = require('puppeteer');
const axios = require('axios');
puppeteer.use(StealthPlugin());

const app = express();
const PORT = 7860;

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
        const cleanedPath = bestMatch.replace(/^\/anime\//, '').replace(/\/$/, '');
        const modifiedUrl = `${cleanedPath}-episode-${episode}/`;

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

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
