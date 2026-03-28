const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');

const DATA_GOV_BASE = 'https://api.data.gov.in/resource/9ef84268-d588-465a-a308-a864a43d0070';
const mandiCache = new Map();
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * GET /api/mandi/prices
 * Proxy for GOI Agmarknet price feed.
 */
router.get('/prices', authenticateToken, async (req, res) => {
  try {
    const { state = 'Karnataka', commodity } = req.query;
    const cacheKey = `${state}:${commodity || 'all'}`;
    const cached = mandiCache.get(cacheKey);

    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return res.json({ success: true, data: cached.data });
    }

    const apiKey = process.env.DATA_GOV_API_KEY;
    if (!apiKey) throw new Error('DATA_GOV_API_KEY is missing');

    const params = new URLSearchParams({ 'api-key': apiKey, 'format': 'json', 'limit': '150' });
    if (state) params.append('filters[state]', state);
    if (commodity) params.append('filters[commodity]', commodity);

    const apiRes = await fetch(`${DATA_GOV_BASE}?${params.toString()}`, { headers: { Accept: 'application/json' } });
    if (!apiRes.ok) throw new Error(`data.gov.in API error: ${apiRes.status}`);
    
    const json = await apiRes.json();
    const records = (json.records || []).map((r, i) => ({
      id: `${r.commodity}-${r.market}-${r.arrival_date}-${i}`,
      state: r.state, market: r.market, commodity: r.commodity, variety: r.variety || r.commodity,
      arrival_date: r.arrival_date, min_price: parseFloat(r.min_price), 
      max_price: parseFloat(r.max_price), modal_price: parseFloat(r.modal_price),
    }));

    mandiCache.set(cacheKey, { data: records, fetchedAt: Date.now() });
    res.json({ success: true, data: records });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
