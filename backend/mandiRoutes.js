// ============================================================
// KrishiSethu — Mandi Price Feed Routes
// Source: AGMARKNET via data.gov.in Open Government Data API
// ============================================================

const mandiCache = new Map();
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

const DATA_GOV_BASE = 'https://api.data.gov.in/resource/9ef84268-d588-465a-a308-a864a43d0070';

// ── Fetch from data.gov.in ────────────────────────────────────
const fetchAgmarknet = async ({ state, commodity, limit = 100 }) => {
  const apiKey = process.env.DATA_GOV_API_KEY;
  if (!apiKey) throw new Error('DATA_GOV_API_KEY is missing');

  const params = new URLSearchParams({
    'api-key': apiKey,
    'format': 'json',
    'limit': String(limit),
    'offset': '0',
  });

  if (state) params.append('filters[state]', state);
  if (commodity) params.append('filters[commodity]', commodity);

  const url = `${DATA_GOV_BASE}?${params.toString()}`;
  console.log('[MANDI] Fetching:', url.replace(apiKey, 'REDACTED'));
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30000), // Increased to 30s
  });

  if (!res.ok) throw new Error(`data.gov.in API error: ${res.status} ${res.statusText}`);

  const json = await res.json();

  if (!json.records || !Array.isArray(json.records)) {
    throw new Error('Unexpected response format from data.gov.in');
  }

  return json.records;
};

// ── Normalise raw AGMARKNET record ────────────────────────────
const normaliseRecord = (raw, idx) => ({
  id: `${raw.commodity}-${raw.market}-${raw.arrival_date}-${idx}`,
  state: raw.state || '',
  district: raw.district || '',
  market: raw.market || '',
  commodity: raw.commodity || '',
  variety: raw.variety || raw.commodity || '',
  arrival_date: raw.arrival_date || '',
  min_price: parseFloat(raw.min_price) || 0,
  max_price: parseFloat(raw.max_price) || 0,
  modal_price: parseFloat(raw.modal_price) || 0,
});

// ── Trend calculation ─────────────────────────────────────────
const calcTrend = (current, previousMap) => {
  const key = `${current.commodity}|${current.market}`;
  const prev = previousMap?.get(key);
  if (!prev || prev === current.modal_price) return { trend: 'flat', trend_pct: 0 };

  const pct = Math.round(((current.modal_price - prev) / prev) * 100);
  return {
    trend: pct > 0 ? 'up' : 'down',
    trend_pct: pct,
  };
};

module.exports = function (app, supabase, authenticateToken, requireAdmin) {

  // ============================================================
  // ROUTE 1: Get mandi prices
  // GET /api/mandi/prices?state=Karnataka&commodity=Tomato
  // ============================================================
  app.get('/api/mandi/prices', authenticateToken, async (req, res) => {
    try {
      const { state = 'Karnataka', commodity } = req.query;
      const cacheKey = `${state}:${commodity || 'all'}`;

      // Return cached data if fresh
      const cached = mandiCache.get(cacheKey);
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return res.json({ success: true, data: cached.data, source: 'cache' });
      }

      // Fetch fresh data
      let raw;
      try {
        raw = await fetchAgmarknet({ state, commodity, limit: 150 });
      } catch (apiErr) {
        // If data.gov.in is down, return cached stale data rather than erroring
        if (cached) {
          console.warn('[MANDI] data.gov.in unavailable, serving stale cache:', apiErr.message);
          return res.json({ success: true, data: cached.data, source: 'stale_cache' });
        }
        throw apiErr;
      }

      // Normalise records
      const records = raw.map((r, i) => normaliseRecord(r, i));

      // Deduplicate — keep most recent entry per commodity+market combo
      const deduped = new Map();
      for (const r of records) {
        const key = `${r.commodity}|${r.market}`;
        if (!deduped.has(key)) deduped.set(key, r);
      }
      const unique = Array.from(deduped.values());

      // Attach trend data from previous cache snapshot
      const prevCache = mandiCache.get(`${cacheKey}:prev`);
      const prevMap = prevCache
        ? new Map(prevCache.data.map(r => [`${r.commodity}|${r.market}`, r.modal_price]))
        : null;

      const withTrends = unique.map(r => ({
        ...r,
        ...calcTrend(r, prevMap),
      }));

      // Save current as previous before overwriting
      if (cached) mandiCache.set(`${cacheKey}:prev`, cached);

      // Cache the new data
      mandiCache.set(cacheKey, { data: withTrends, fetchedAt: Date.now() });

      res.json({ success: true, data: withTrends, source: 'live' });
    } catch (err) {
      console.error('[MANDI_ERROR]', err.message);
      // Temporary log file for debugging (I'll read this)
      try {
        require('fs').appendFileSync(require('path').join(__dirname, 'mandi_error.log'), `${new Date().toISOString()} - ${err.message}\n`);
      } catch (logErr) { }

      res.status(502).json({
        error: `Mandi API Error: ${err.message}`,
      });
    }
  });

  // ============================================================
  // ROUTE 2: Get top prices for a specific crop across India
  // GET /api/mandi/prices/top?commodity=Tomato&limit=10
  // ============================================================
  app.get('/api/mandi/prices/top', authenticateToken, async (req, res) => {
    try {
      const { commodity, limit = 10 } = req.query;
      if (!commodity) return res.status(400).json({ error: 'commodity is required' });

      const cacheKey = `top:${commodity}`;
      const cached = mandiCache.get(cacheKey);
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        return res.json({ success: true, data: cached.data });
      }

      const raw = await fetchAgmarknet({ commodity, limit: 200 });
      const records = raw.map((r, i) => normaliseRecord(r, i));

      // Sort by modal price descending, deduplicate by market
      const deduped = new Map();
      for (const r of records.sort((a, b) => b.modal_price - a.modal_price)) {
        if (!deduped.has(r.market)) deduped.set(r.market, r);
      }

      const top = Array.from(deduped.values()).slice(0, parseInt(limit));
      mandiCache.set(cacheKey, { data: top, fetchedAt: Date.now() });

      res.json({ success: true, data: top });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ============================================================
  // ROUTE 3: Clear cache (admin only)
  // POST /api/admin/mandi/clear-cache
  // ============================================================
  app.post('/api/admin/mandi/clear-cache', authenticateToken, requireAdmin, async (req, res) => {
    mandiCache.clear();
    res.json({ success: true, message: 'Mandi price cache cleared.' });
  });

};
