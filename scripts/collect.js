/**
 * Collecte RSS — Connected Innovation Center
 * Lit config.json, agrège les flux, filtre, catégorise, écrit <destination>.json
 */

const fs = require('fs');
const path = require('path');
const Parser = require('rss-parser');

const ROOT = path.resolve(__dirname, '..');
const UA = 'CIC-feed-reader/1.0 (+https://thomasarnaudacc.github.io/cic-feeds)';

const parser = new Parser({
  timeout: 10000,
  headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
});

/* ---------- utilitaires ---------- */

const deaccent = (s) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const normalize = (s) =>
  deaccent(String(s || '').toLowerCase())
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&laquo;|&raquo;/gi, '"')
    .replace(/&rsquo;|&#8217;/gi, "'")
    .replace(/&hellip;/gi, '…')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripHtml(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(s, max) {
  const t = stripHtml(s);
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:–—-]$/, '') + '…';
}

const SOURCE_NAMES = {
  'retaildive.com': 'Retail Dive',
  'grocerydive.com': 'Grocery Dive',
  'fooddive.com': 'Food Dive',
  'retailtechnology.co.uk': 'Retail Technology',
  'retailcustomerexperience.com': 'Retail Customer Experience',
  'techcrunch.com': 'TechCrunch',
  'olivierdauvers.fr': 'Olivier Dauvers',
  'usine-digitale.fr': "L'Usine Digitale",
  'ecommercemag.fr': 'Ecommerce Mag',
  'frenchweb.fr': 'FrenchWeb',
  'journaldunet.com': 'Journal du Net',
  'maddyness.com': 'Maddyness',
};

function sourceName(feedUrl) {
  let host;
  try {
    host = new URL(feedUrl).hostname.replace(/^www\./, '').replace(/^fr\./, '');
  } catch (e) {
    return 'Source';
  }
  return SOURCE_NAMES[host] || host;
}

/* ---------- récupération ---------- */

async function fetchFeed(url) {
  const label = sourceName(url);
  try {
    const feed = await parser.parseURL(url);
    const items = feed.items || [];
    console.log(`  OK    ${String(items.length).padStart(3)} items  ${label}`);
    return items.map((it) => ({
      title: stripHtml(it.title),
      excerpt: truncate(it.contentSnippet || it.summary || it.content || it.description || '', 150),
      link: it.link || '',
      source: label,
      pubDate: it.isoDate || it.pubDate || null,
    }));
  } catch (err) {
    console.log(`  ÉCHEC   0 items  ${label} — ${err.message}`);
    return [];
  }
}

/* ---------- filtrage et catégorisation ---------- */

function isExcluded(item, excludeList) {
  const t = normalize(item.title);
  return excludeList.some((w) => t.includes(normalize(w)));
}

function categorize(item, taxonomy) {
  const title = normalize(item.title);
  const body = normalize(item.excerpt);
  let best = null;
  let bestScore = 0;

  for (const [category, keywords] of Object.entries(taxonomy)) {
    let score = 0;
    for (const kw of keywords) {
      const k = normalize(kw);
      if (!k) continue;
      if (title.includes(k)) score += 2;
      if (body.includes(k)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = category;
    }
  }
  return bestScore > 0 ? best : null;
}

/* ---------- quotas ---------- */

function capPerSource(items, max) {
  const count = {};
  return items.filter((it) => {
    count[it.source] = (count[it.source] || 0) + 1;
    return count[it.source] <= max;
  });
}

function spreadCategories(items, maxConsecutive) {
  const pool = items.slice();
  const out = [];
  let run = 0;

  while (pool.length) {
    let idx = 0;
    if (out.length && run >= maxConsecutive) {
      const last = out[out.length - 1].category;
      const alt = pool.findIndex((it) => it.category !== last);
      if (alt !== -1) idx = alt;
    }
    const picked = pool.splice(idx, 1)[0];
    if (out.length && out[out.length - 1].category === picked.category) run += 1;
    else run = 1;
    out.push(picked);
  }
  return out;
}

/* ---------- traitement d'une langue ---------- */

async function buildLanguage(urls, cfg, pinned) {
  const results = await Promise.all(urls.map(fetchFeed));
  const raw = results.flat();
  const maxAge = Date.now() - cfg.limits.maxAgeDays * 86400000;

  const seen = new Set(pinned.map((p) => normalize(p.title)));
  const kept = [];
  let droppedAge = 0;
  let droppedExclude = 0;
  let droppedNoCategory = 0;
  let droppedDupe = 0;

  for (const item of raw) {
    if (!item.title || !item.link) continue;

    const ts = item.pubDate ? Date.parse(item.pubDate) : NaN;
    if (!Number.isNaN(ts) && ts < maxAge) {
      droppedAge += 1;
      continue;
    }
    if (isExcluded(item, cfg.exclude)) {
      droppedExclude += 1;
      continue;
    }
    const category = categorize(item, cfg.taxonomy);
    if (!category) {
      droppedNoCategory += 1;
      continue;
    }
    const key = normalize(item.title);
    if (seen.has(key)) {
      droppedDupe += 1;
      continue;
    }
    seen.add(key);
    kept.push({ ...item, category, pinned: false });
  }

  kept.sort((a, b) => {
    const da = a.pubDate ? Date.parse(a.pubDate) : 0;
    const db = b.pubDate ? Date.parse(b.pubDate) : 0;
    return db - da;
  });

  const slots = Math.max(0, cfg.limits.maxItems - pinned.length);
  let selected = capPerSource(kept, cfg.limits.maxPerSource).slice(0, slots);
  selected = spreadCategories(selected, cfg.limits.maxConsecutiveCategory);

  console.log(
    `  → ${raw.length} bruts | rejets : ${droppedAge} âge, ${droppedExclude} exclusion, ` +
      `${droppedNoCategory} hors taxonomie, ${droppedDupe} doublons | ${selected.length} retenus ` +
      `(+ ${pinned.length} épinglés)`
  );

  return [...pinned, ...selected];
}

/* ---------- main ---------- */

async function main() {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

  for (const [destination, cfg] of Object.entries(config)) {
    console.log(`\n=== ${destination} ===`);

    const outPath = path.join(ROOT, `${destination}.json`);
    let previous = { itemsFr: [], itemsEn: [] };
    if (fs.existsSync(outPath)) {
      try {
        previous = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      } catch (e) {
        console.log(`  (fichier existant illisible, ignoré : ${e.message})`);
      }
    }
    const pinnedFr = (previous.itemsFr || []).filter((i) => i.pinned === true);
    const pinnedEn = (previous.itemsEn || []).filter((i) => i.pinned === true);

    console.log('\n-- FR --');
    const itemsFr = await buildLanguage(cfg.feeds.fr || [], cfg, pinnedFr);

    console.log('\n-- EN --');
    const itemsEn = await buildLanguage(cfg.feeds.en || [], cfg, pinnedEn);

    const payload = {
      destination,
      publishedAt: new Date().toISOString(),
      itemsFr,
      itemsEn,
    };

    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    console.log(`\n  Écrit ${destination}.json — ${itemsFr.length} FR / ${itemsEn.length} EN`);
  }
}

main().catch((err) => {
  console.error('Erreur fatale :', err);
  process.exit(1);
});
