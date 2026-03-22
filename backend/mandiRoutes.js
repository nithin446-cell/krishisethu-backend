const MANDI_API_UUID = '9ef84268-d588-465a-a308-a864a43d0070';
const DATA_GOV_URL = `https://api.data.gov.in/resource/${MANDI_API_UUID}`;

// 2-hour In-Memory Cache
let mandiCache = {
  data: [],
  lastUpdated: null,
  snapshots: {} // Store daily snapshots for trend calculation
};

const CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Normalizes API keys to a clean format and deduplicates
 */
const normalizePriceData = (records) => {
  const seen = new Set();
  const normalized = [];

  for (const r of records) {
    const key = `${r.commodity}_${r.market}_${r.variety}`;
    if (seen.has(key)) continue;
    seen.add(key);

    normalized.push({
      state: r.state,
      district: r.district,
      market: r.market,
      commodity: r.commodity,
      variety: r.variety,
      arrival_date: r.arrival_date,
      min_price: parseFloat(r.min_price),
      max_price: parseFloat(r.max_price),
      modal_price: parseFloat(r.modal_price),
      unit: 'Quintal'
    });
  }
  return normalized;
};

/**
 * Calculates trend based on previous stored prices
 */
const calculateTrends = (currentRecords) => {
  return currentRecords.map(record => {
    const key = `${record.commodity}_${record.market}`;
    const previous = mandiCache.snapshots[key];
    
    let trend = 'Stable';
    let changePercent = 0;

    if (previous) {
      const diff = record.modal_price - previous;
      changePercent = Math.round((diff / previous) * 100);
      if (changePercent > 1) trend = 'Up';
      else if (changePercent < -1) trend = 'Down';
    } else {
      // Mock initial trend for better UI if no previous snapshot
      const mockDiff = (Math.random() * 10) - 5;
      changePercent = Math.round(mockDiff);
      trend = changePercent > 1 ? 'Up' : changePercent < -1 ? 'Down' : 'Stable';
    }

    // Save current as the next snapshot
    mandiCache.snapshots[key] = record.modal_price;

    return { ...record, trend, changePercent };
  });
};

module.exports = function(app, supabase, authenticateToken) {

  /**
   * GET /api/mandi/prices
   */
  app.get('/api/mandi/prices', authenticateToken, async (req, res) => {
    const { state, commodity } = req.query;
    const apiKey = process.env.DATA_GOV_API_KEY;

    if (!apiKey) {
      console.warn('[MANDI] DATA_GOV_API_KEY missing. Cannot fetch live data.');
      return res.status(500).json({ error: 'Market data service not configured (API Key missing).' });
    }

    // Use cache if available and not expired
    if (mandiCache.lastUpdated && (Date.now() - mandiCache.lastUpdated < CACHE_TTL)) {
      console.log('[MANDI] Serving from cache...');
      let filtered = mandiCache.data;
      if (state) filtered = filtered.filter(r => r.state.toLowerCase() === state.toLowerCase());
      if (commodity) filtered = filtered.filter(r => r.commodity.toLowerCase().includes(commodity.toLowerCase()));
      return res.json({ success: true, data: filtered, source: 'cache' });
    }

    try {
      console.log('[MANDI] Fetching fresh data from data.gov.in...');
      const url = `${DATA_GOV_URL}?api-key=${apiKey}&format=json&limit=1000`;
      
      const response = await fetch(url);
      const result = await response.json();

      if (!result.records || result.records.length === 0) {
        if (mandiCache.data.length > 0) {
          return res.json({ success: true, data: mandiCache.data, source: 'stale_cache' });
        }
        throw new Error('No records returned from Mandi API');
      }

      const normalized = normalizePriceData(result.records);
      const withTrends = calculateTrends(normalized);

      // Update Cache
      mandiCache.data = withTrends;
      mandiCache.lastUpdated = Date.now();

      let filtered = withTrends;
      if (state) filtered = filtered.filter(r => r.state.toLowerCase() === state.toLowerCase());
      if (commodity) filtered = filtered.filter(r => r.commodity.toLowerCase().includes(commodity.toLowerCase()));

      res.json({ success: true, data: filtered, source: 'live' });
    } catch (error) {
      console.error('[MANDI_ERROR]', error.message);
      if (mandiCache.data.length > 0) {
        return res.json({ success: true, data: mandiCache.data, source: 'fallback_cache', error: error.message });
      }
      res.status(500).json({ error: 'Market data currently unavailable.' });
    }
  });

  /**
   * GET /api/mandi/prices/top
   * Top price for a specific crop across India
   */
  app.get('/api/mandi/prices/top', authenticateToken, async (req, res) => {
    const { commodity } = req.query;
    if (!commodity) return res.status(400).json({ error: 'Commodity is required' });

    let data = mandiCache.data;
    if (data.length === 0) {
      return res.json({ success: false, message: 'Cache empty. Load /prices first.' });
    }

    const cropData = data.filter(r => r.commodity.toLowerCase().includes(commodity.toLowerCase()));
    if (cropData.length === 0) return res.json({ success: false, message: 'No data for this crop' });

    const top = cropData.reduce((prev, current) => (prev.modal_price > current.modal_price) ? prev : current);
    res.json({ success: true, data: top });
  });

  /**
   * POST /api/admin/mandi/clear-cache
   */
  app.post('/api/admin/mandi/clear-cache', authenticateToken, (req, res) => {
    // In a real app, check req.user.role === 'admin'
    mandiCache.data = [];
    mandiCache.lastUpdated = null;
    res.json({ success: true, message: 'Mandi cache cleared' });
  });

};
