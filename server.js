const express = require('express');
const path = require('path');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════
// HEALTH
// ═══════════════════════════════════════════════
app.get('/api/health', async (req, res) => {
  try {
    const data = await ollamaRequest('/api/tags', 'GET');
    const models = (data.models || []).map(m => m.name);
    res.json({ status: 'ok', ollama: true, models });
  } catch {
    res.json({ status: 'ok', ollama: false, models: [] });
  }
});

// ═══════════════════════════════════════════════
// EXPAND — The core thinking step
// ═══════════════════════════════════════════════
app.post('/api/expand', async (req, res) => {
  const { keywords, cycle = 1, previousKeywords = [] } = req.body;

  const system = `You are a search query generator for visual discovery. You take keywords and generate DIVERSE search queries that will find photographs, scientific imagery, contemporary art, nature photography, design, and illustrations.
IMPORTANT: Every set of queries must be COMPLETELY DIFFERENT from any previous set. Never repeat a query you've used before. Push into unexpected territory every time.`;

  // Rotate the framing each cycle so Mistral doesn't pattern-match
  const framings = [
    'Think like a NATURE PHOTOGRAPHER: what would you shoot if given these concepts?',
    'Think like a SCIENCE JOURNALIST: what research imagery relates to these ideas?',
    'Think like a DESIGN CURATOR at a contemporary gallery: what visual work connects here?',
    'Think like a DOCUMENTARY FILMMAKER scouting locations and subjects for these themes.',
    'Think like a BIOLOGIST with a macro lens: what living systems embody these concepts?',
    'Think like an ARCHITECT surveying structures that express these ideas.',
    'Think like a FOOD PHOTOGRAPHER: what ingredients, textures, preparations connect?',
    'Think like a SATELLITE OPERATOR: what does Earth look like through the lens of these concepts?'
  ];
  const framing = framings[(cycle + Math.floor(Math.random() * 3)) % framings.length];

  const prompt = `Keywords: ${keywords.join(', ')}
${previousKeywords.length ? `ALREADY SEARCHED (do NOT repeat or rephrase these): ${previousKeywords.slice(-15).join(', ')}` : ''}
Cycle: ${cycle}

${framing}

Generate exactly 10 search queries. Rules:
- Each query 1-4 words
- At least 3 must find PHOTOGRAPHS (not paintings or illustrations)
- At least 2 must find SCIENTIFIC or NATURE imagery (electron microscope, macro, satellite, specimen)
- At least 2 must find CONTEMPORARY work (post-1950 photography, design, architecture)
- Remaining can be anything surprising — objects, textures, places, phenomena
- CRITICAL: NEVER include any of the seed keywords in your queries. Not even as part of a compound word. Transform completely.
- Keep queries SHORT: 1-3 words max. These are search engine queries, not descriptions.
- Be specific. "blue" → "cyanotype" or "morpho wing" not "blue art photography"

One query per line. No numbering, labels, or quotes. Just the short search terms.`;

  try {
    const data = await ollamaRequest('/api/generate', 'POST', {
      model: 'mistral',
      prompt,
      system,
      stream: false,
      options: { temperature: 1.2, top_p: 0.95, num_predict: 150 }
    });
    const kwLower = keywords.map(k => k.toLowerCase());
    const queries = data.response
      .split('\n')
      .map(l => l.replace(/^\s*[\d]+[\.\)\-\:]+\s*/, '').replace(/^[\-\*\u2022]+\s*/, '').replace(/^["']|["']$/g, '').trim())
      .filter(l => l.length > 1 && l.length < 50)
      // Strip queries that just repeat the seed keywords
      .filter(l => !kwLower.some(k => l.toLowerCase().includes(k)))
      .slice(0, 10);
    res.json({ queries: queries.length > 2 ? queries : keywords });
  } catch (e) {
    console.error('Expand error:', e.message);
    res.json({ queries: keywords, fallback: true });
  }
});

// ═══════════════════════════════════════════════
// SEARCH — Aggregated multi-source image search
// Searches 4 reliable sources with controlled parallelism
// ═══════════════════════════════════════════════
app.post('/api/search', async (req, res) => {
  try {
    const { queries } = req.body;
    if (!queries || queries.length === 0) {
      return res.json({ images: [], total: 0 });
    }

    const allResults = [];

    // Source pool — each query gets 3-4 sources, rotated for variety
    const allSources = [
      { fn: searchWikimedia, name: 'Wikimedia' },
      { fn: searchArtIC, name: 'AIC' },
      { fn: searchEuropeana, name: 'Europeana' },
      { fn: searchMet, name: 'Met' },
      { fn: searchCleveland, name: 'Cleveland' },
      { fn: searchLOC, name: 'LOC' },
      { fn: searchArchiveOrg, name: 'Archive' },
      { fn: searchINaturalist, name: 'iNaturalist' },
      { fn: searchNASA, name: 'NASA' },
    ];

    // Distribute: each query gets a rotating subset of sources
    // This prevents every query hitting the same API (which causes repeats)
    const batchPromises = [];
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      // Pick 3 sources, rotating start position each query
      const offset = (i * 3) % allSources.length;
      for (let s = 0; s < 3; s++) {
        const src = allSources[(offset + s) % allSources.length];
        batchPromises.push(
          src.fn(q).catch(e => { console.log(`${src.name} failed for "${q}":`, e.message); return []; })
        );
      }
    }

    // Also always run a few photo-forward searches with the raw keywords
    const photoQuery = queries.slice(0, 2).join(' ');
    batchPromises.push(
      searchINaturalist(photoQuery).catch(() => []),
      searchNASA(photoQuery).catch(() => [])
    );

    const results = await Promise.allSettled(batchPromises);
    for (const r of results) {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        allResults.push(...r.value);
      }
    }

    // Filter out text-heavy content (newspapers, documents, ledgers)
    const TEXT_REJECT = /\b(newspaper|gazette|journal|ledger|proceedings|minutes|census|directory|catalog|catalogue|periodical|bulletin|advertisement|advert|classified|obituar|clipping|front page|editorial|masthead|broadside|pamphlet|circular|handbill|leaflet|transcript|index|register|vol\.|issue\s+\d|page\s+\d|pp\.\s*\d)\b/i;
    const filtered = allResults.filter(img => {
      const t = (img.title || '') + ' ' + (img.source || '');
      return !TEXT_REJECT.test(t);
    });

    // Deduplicate
    const seen = new Set();
    const unique = filtered.filter(img => {
      const key = img.imageUrl || img.thumbUrl;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Shuffle
    for (let i = unique.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [unique[i], unique[j]] = [unique[j], unique[i]];
    }

    console.log(`Search: ${queries.length} queries -> ${allResults.length} raw -> ${unique.length} unique`);
    res.json({ images: unique.slice(0, 40), total: unique.length });
  } catch (e) {
    console.error('Search handler error:', e);
    res.status(500).json({ error: e.message, images: [] });
  }
});

// ═══════════════════════════════════════════════
// CURATE — LLaVA picks the most interesting images
// ═══════════════════════════════════════════════
app.post('/api/curate', async (req, res) => {
  const { images, keywords, count = 16 } = req.body;

  const scored = [];

  // Score up to 20 images, one at a time to avoid overloading LLaVA
  for (let i = 0; i < Math.min(images.length, 20); i++) {
    const img = images[i];
    try {
      const buffer = await fetchImageBuffer(img.thumbUrl || img.imageUrl);
      if (buffer.length < 1000) { scored.push({ ...img, score: 3 }); continue; }
      const base64 = buffer.toString('base64');

      const data = await ollamaRequest('/api/generate', 'POST', {
        model: 'llava',
        prompt: `Rate this image 1-10 for a mood board about: ${keywords.join(', ')}
Consider: visual complexity, emotional resonance, unexpectedness, beauty.
Reply with ONLY a number 1-10 and a short reason.
Format: SCORE: [number] WHY: [reason]`,
        images: [base64],
        stream: false,
        options: { temperature: 0.3, num_predict: 50 }
      });

      const scoreMatch = data.response.match(/SCORE:\s*(\d+)/i);
      const whyMatch = data.response.match(/WHY:\s*(.+)/i);
      scored.push({
        ...img,
        score: scoreMatch ? parseInt(scoreMatch[1]) : 5,
        aiDescription: whyMatch ? whyMatch[1].trim() : ''
      });
    } catch {
      scored.push({ ...img, score: 5, aiDescription: '' });
    }
  }

  // Add remaining unscored
  for (let i = scored.length; i < images.length; i++) {
    scored.push({ ...images[i], score: 4, aiDescription: '' });
  }

  scored.sort((a, b) => b.score - a.score);
  const curated = scored.slice(0, count);
  const descriptions = curated
    .filter(img => img.aiDescription)
    .map(img => `"${img.title}": ${img.aiDescription}`)
    .slice(0, 5);

  res.json({ images: curated, descriptions });
});

// ═══════════════════════════════════════════════
// QUESTION — Generate contextual interrogation
// ═══════════════════════════════════════════════
app.post('/api/question', async (req, res) => {
  const { step, totalSteps, keywords, previousAnswers, imageDescriptions } = req.body;

  const system = `You are the Curiosity Engine — a Socratic guide that leads users deeper into their own thinking through art.
You generate single, precise questions that crack open unexpected angles.
Never ask generic "how does this make you feel" questions.
Be specific. Be strange. Be illuminating.
Output ONLY the question — no preamble, no labels, no quotes.`;

  const prompts = {
    1: `The user is looking at a mood board seeded with: ${keywords.join(', ')}
${imageDescriptions ? `The images include: ${imageDescriptions}` : ''}
Ask one question about what PATTERN they notice across the images — not what they see, but what invisible thread connects them.`,

    2: `Seeds: ${keywords.join(', ')}
${imageDescriptions ? `Images: ${imageDescriptions}` : ''}
Their first response: "${(previousAnswers || {})[0] || '...'}"
Ask them to find a CONTRADICTION or TENSION in what they described.`,

    3: `Seeds: ${keywords.join(', ')}
Responses so far: ${JSON.stringify(previousAnswers || {})}
Ask them to NAME the force or phenomenon underneath — not a feeling, but a principle. Like gravity, erosion, metabolism, recursion.`,

    4: `Seeds: ${keywords.join(', ')}
Responses: ${JSON.stringify(previousAnswers || {})}
Ask them to TRANSLATE their principle into a completely different domain — music, biology, architecture, cuisine.`,

    5: `Seeds: ${keywords.join(', ')}
Full journey: ${JSON.stringify(previousAnswers || {})}
Ask what they now understand about the ORIGINAL seeds (${keywords.join(', ')}) that they couldn't have seen before.`
  };

  try {
    const data = await ollamaRequest('/api/generate', 'POST', {
      model: 'mistral',
      prompt: prompts[step] || prompts[1],
      system,
      stream: false,
      options: { temperature: 0.9, num_predict: 100 }
    });
    res.json({ question: data.response.trim() });
  } catch (e) {
    res.status(502).json({ error: 'Question generation failed', fallback: true });
  }
});

// ═══════════════════════════════════════════════
// SYNTHESIZE — Weave reflections into next seeds
// ═══════════════════════════════════════════════
app.post('/api/synthesize', async (req, res) => {
  const { keywords, answers, imageDescriptions, cycle } = req.body;

  const system = `You are a lateral thinker. You find surprising, SPECIFIC connections — never vague or poetic-sounding.
BANNED words/concepts you must NEVER use: metamorphosis, transformation, duality, juxtaposition, ephemeral, transcendence, liminal, dichotomy, interplay, tapestry, mosaic, kaleidoscope, journey, dance, symphony, echo, mirror, bridge, vessel, chrysalis, alchemy, weave, thread of life.
Instead be CONCRETE and WEIRD. Name specific materials, places, organisms, processes, tools, recipes, weather patterns, geological formations, musical instruments, architectural elements, chemical reactions.`;

  // Vary phrasing each cycle so Mistral doesn't pattern-match to the same output
  const angles = [
    'What specific MATERIAL or SUBSTANCE connects these ideas? Name it.',
    'What TRADE, CRAFT, or PROFESSION would work with all of these concepts?',
    'What PLACE on Earth would all of these ideas coexist naturally?',
    'What specific ORGANISM (plant, animal, fungus, microbe) embodies these concepts?',
    'What TOOL or INSTRUMENT connects these ideas?',
    'What WEATHER PHENOMENON or GEOLOGICAL PROCESS relates to all of these?',
    'What specific RECIPE or FOOD connects these concepts?',
    'What ARCHITECTURAL ELEMENT or BUILDING TECHNIQUE ties these together?'
  ];
  const angle = angles[(cycle || 0) % angles.length];

  const prompt = `Keywords explored: ${keywords.join(', ')}
Cycle: ${cycle || 1}

${angle}

Write ONE specific, surprising sentence about this connection. Be concrete — name real things, not abstractions.

Then suggest 5 keywords for the next exploration. Rules:
- At least 2 must be physical/tangible things (a specific animal, mineral, tool, food, place)
- At least 1 must be from a domain UNRELATED to the current keywords
- NO abstract philosophical concepts — every keyword should be something you could photograph
- Surprise me. If the keywords are about "rust" and "memory", don't say "patina" — say "bog iron", "palimpsest", "mycelium network", "Venetian plaster", "fermentation"

Format exactly:
THREAD: [your concrete observation]
NEXT: [kw1], [kw2], [kw3], [kw4], [kw5]`;

  try {
    const data = await ollamaRequest('/api/generate', 'POST', {
      model: 'mistral',
      prompt,
      system,
      stream: false,
      options: { temperature: 0.95, num_predict: 200 }
    });
    res.json({ response: data.response });
  } catch (e) {
    console.error('Synthesis error:', e.message);
    res.status(502).json({ error: 'Synthesis unavailable', fallback: true });
  }
});

// ═══════════════════════════════════════════════
// IMAGE SOURCE APIS
// ═══════════════════════════════════════════════

// Art Institute of Chicago — reliable, CORS, no key needed
async function searchArtIC(query) {
  const url = `https://api.artic.edu/api/v1/artworks/search?q=${encodeURIComponent(query)}&fields=id,title,image_id,artist_display,date_display&limit=8`;
  const data = await fetchJSON(url);
  return (data.data || [])
    .filter(item => item.image_id)
    .map(item => ({
      title: item.title || 'Untitled',
      artist: item.artist_display || '',
      date: item.date_display || '',
      imageUrl: `https://www.artic.edu/iiif/2/${item.image_id}/full/1200,/0/default.jpg`,
      thumbUrl: `https://www.artic.edu/iiif/2/${item.image_id}/full/600,/0/default.jpg`,
      source: 'Art Institute of Chicago',
      sourceUrl: `https://www.artic.edu/artworks/${item.id}`,
      query
    }));
}

// Europeana — huge, reliable
async function searchEuropeana(query) {
  const start = Math.floor(Math.random() * 5) + 1; // randomize page
  const url = `https://api.europeana.eu/record/v2/search.json?wskey=api2demo&query=${encodeURIComponent(query)}&media=true&thumbnail=true&rows=10&start=${start}&profile=rich&qf=TYPE:IMAGE`;
  const data = await fetchJSON(url);
  return (data.items || [])
    .filter(item => item.edmPreview && item.edmPreview[0])
    .map(item => ({
      title: (item.title && item.title[0]) || 'Untitled',
      artist: (item.dcCreator && item.dcCreator[0]) || '',
      date: (item.year && item.year[0]) || '',
      imageUrl: item.edmPreview[0],
      thumbUrl: item.edmPreview[0],
      source: (item.dataProvider && item.dataProvider[0]) || 'Europeana',
      sourceUrl: item.guid || '',
      query
    }));
}

// Wikimedia Commons — broad, reliable
async function searchWikimedia(query) {
  const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(query)}+-newspaper+-gazette+-journal+-clipping&gsrlimit=10&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=1200&format=json&origin=*`;
  const data = await fetchJSON(url);
  if (!data.query || !data.query.pages) return [];
  return Object.values(data.query.pages)
    .filter(p => p.imageinfo && p.imageinfo[0] && p.imageinfo[0].thumburl
      && !/\.(svg|pdf|djvu)$/i.test(p.imageinfo[0].thumburl)
      && !/\.(svg|pdf|djvu)/i.test(p.title || ''))
    .map(p => {
      const info = p.imageinfo[0];
      const meta = info.extmetadata || {};
      return {
        title: (meta.ObjectName && meta.ObjectName.value) || p.title.replace('File:', ''),
        artist: (meta.Artist && meta.Artist.value.replace(/<[^>]+>/g, '')) || '',
        date: (meta.DateTimeOriginal && meta.DateTimeOriginal.value) || '',
        imageUrl: info.thumburl,
        thumbUrl: info.thumburl,
        source: 'Wikimedia Commons',
        sourceUrl: info.descriptionurl || '',
        query
      };
    });
}

// Metropolitan Museum of Art — open access, no key
async function searchMet(query) {
  const searchUrl = `https://collectionapi.metmuseum.org/public/collection/v1/search?hasImages=true&q=${encodeURIComponent(query)}`;
  const searchData = await fetchJSON(searchUrl);
  if (!searchData.objectIDs || searchData.objectIDs.length === 0) return [];

  // Random subset for variety, limit to 4 to keep things fast
  const ids = searchData.objectIDs.sort(() => Math.random() - 0.5).slice(0, 6);
  const objects = await Promise.allSettled(
    ids.map(id => fetchJSON(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`))
  );

  return objects
    .filter(r => r.status === 'fulfilled' && r.value.primaryImageSmall)
    .map(r => {
      const obj = r.value;
      return {
        title: obj.title || 'Untitled',
        artist: obj.artistDisplayName || '',
        date: obj.objectDate || '',
        imageUrl: obj.primaryImage || obj.primaryImageSmall,
        thumbUrl: obj.primaryImageSmall,
        source: 'Metropolitan Museum',
        sourceUrl: obj.objectURL || '',
        query
      };
    });
}

// Cleveland Museum of Art — strong contemporary + modern collection, open access
async function searchCleveland(query) {
  const url = `https://openaccess-api.clevelandart.org/api/artworks/?q=${encodeURIComponent(query)}&has_image=1&limit=8`;
  const data = await fetchJSON(url);
  return (data.data || [])
    .filter(r => r.images && r.images.web && r.images.web.url)
    .map(r => ({
      title: r.title || 'Untitled',
      artist: r.creators && r.creators[0] ? r.creators[0].description : '',
      date: r.creation_date || '',
      imageUrl: r.images.web.url,
      thumbUrl: r.images.web.url,
      source: 'Cleveland Museum of Art',
      sourceUrl: r.url || '',
      query
    }));
}

// Library of Congress — prints, photos, maps, manuscripts
async function searchLOC(query) {
  const url = `https://www.loc.gov/search/?q=${encodeURIComponent(query)}&fo=json&c=10&fa=online-format:image&fa=original-format:photo,print,drawing,painting,poster,map`;
  const data = await fetchJSON(url);
  return (data.results || [])
    .filter(r => r.image_url && r.image_url.length > 1)
    .map(r => {
      const imgs = r.image_url;
      // Pick highest available res, strip hash fragment
      const imageUrl = (imgs[imgs.length - 1] || imgs[1] || imgs[0]).split('#')[0];
      const thumbUrl = (imgs[1] || imgs[0]).split('#')[0];
      return {
        title: r.title || 'Untitled',
        artist: (r.contributor && r.contributor[0]) || '',
        date: (r.date && r.date[0]) || '',
        imageUrl, thumbUrl,
        source: 'Library of Congress',
        sourceUrl: r.url || '',
        query
      };
    });
}

// Archive.org — vast: books, images, ephemera, scientific illustrations
async function searchArchiveOrg(query) {
  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(query)}+mediatype:image&fl[]=identifier,title,creator,date&rows=8&output=json&sort[]=downloads+desc`;
  const data = await fetchJSON(url);
  return (data.response && data.response.docs || [])
    .filter(d => d.identifier)
    .map(d => ({
      title: d.title || 'Untitled',
      artist: d.creator || '',
      date: d.date || '',
      imageUrl: `https://archive.org/services/img/${d.identifier}`,
      thumbUrl: `https://archive.org/services/img/${d.identifier}`,
      source: 'Internet Archive',
      sourceUrl: `https://archive.org/details/${d.identifier}`,
      query
    }));
}

// iNaturalist — nature photography, macro, wildlife, specimens
async function searchINaturalist(query) {
  const url = `https://api.inaturalist.org/v1/observations?q=${encodeURIComponent(query)}&photos=true&per_page=8&order_by=votes&quality_grade=research`;
  const data = await fetchJSON(url);
  return (data.results || [])
    .filter(r => r.photos && r.photos.length > 0)
    .map(r => {
      const photo = r.photos[0];
      const url = (photo.url || '').replace('square', 'medium');
      const largeUrl = (photo.url || '').replace('square', 'large');
      return {
        title: r.species_guess || r.taxon?.name || 'Observation',
        artist: r.user?.login || '',
        date: r.observed_on || '',
        imageUrl: largeUrl,
        thumbUrl: url,
        source: 'iNaturalist',
        sourceUrl: `https://www.inaturalist.org/observations/${r.id}`,
        query
      };
    });
}

// NASA Image and Video Library — space, earth science, technology
async function searchNASA(query) {
  const url = `https://images-api.nasa.gov/search?q=${encodeURIComponent(query)}&media_type=image&page_size=8`;
  const data = await fetchJSON(url);
  const items = data.collection?.items || [];
  return items
    .filter(item => item.links && item.links.length > 0)
    .map(item => {
      const info = (item.data && item.data[0]) || {};
      const href = item.links[0].href || '';
      return {
        title: info.title || 'Untitled',
        artist: info.photographer || info.center || '',
        date: info.date_created ? info.date_created.substring(0, 10) : '',
        imageUrl: href.replace('~thumb', '~medium').replace('~small', '~medium'),
        thumbUrl: href,
        source: 'NASA',
        sourceUrl: `https://images.nasa.gov/details/${info.nasa_id || ''}`,
        query
      };
    });
}

// ═══════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════

function ollamaRequest(urlPath, method, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, OLLAMA_HOST);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 180000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from Ollama')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, { timeout: 10000, headers: { 'User-Agent': 'CuriosityEngine/1.0 (art exploration tool)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJSON(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode >= 400) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from ' + url.substring(0, 60))); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function fetchImageBuffer(imageUrl) {
  return new Promise((resolve, reject) => {
    const proto = imageUrl.startsWith('https') ? https : http;
    proto.get(imageUrl, { timeout: 15000, headers: { 'User-Agent': 'CuriosityEngine/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchImageBuffer(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

app.listen(PORT, () => {
  console.log('');
  console.log('  \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557');
  console.log('  \u2551       Curiothymia                    \u2551');
  console.log(`  \u2551       http://localhost:${PORT}           \u2551`);
  console.log('  \u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d');
  console.log('');
  console.log(`  Ollama: ${OLLAMA_HOST}`);
  console.log('  Sources: AIC \u00b7 Met \u00b7 Cleveland \u00b7 Europeana \u00b7 Wikimedia \u00b7 LOC \u00b7 Archive \u00b7 iNaturalist \u00b7 NASA');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});
