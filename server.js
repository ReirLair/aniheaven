const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
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

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
