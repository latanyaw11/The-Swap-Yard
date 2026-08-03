// ═══════════════════════════════════════════════════════════════
// The Swap Yard — Analytics Aggregator
// File: netlify/functions/analytics.js
//
// SETUP — Schedule in netlify.toml:
//   [functions."analytics"]
//     schedule = "0 1 * * *"   ← runs every day at 1am UTC
//
// WHAT IT DOES:
//   Daily snapshot of key platform metrics saved to analytics_daily table:
//   - New users, active users, listings, orders
//   - Gross Merchandise Volume (GMV)
//   - Barter trades and total FMV
//   - Affiliate clicks and sponsor impressions
//   - Top categories by listing count
//   - Revenue by plan tier
//
// ALSO HANDLES:
//   GET  → Return analytics data for a date range (for admin dashboard)
//   POST (scheduled) → Run daily aggregation job
//
// ENV VARS: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ═══════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // ── GET ANALYTICS DATA (for dashboard display) ────────────
  if (event.httpMethod === 'GET') {
    try {
      const { days = '30', metric } = event.queryStringParameters || {};
      const since = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

      const { data: rows } = await sb
        .from('analytics_daily')
        .select('*')
        .gte('date', since)
        .order('date', { ascending: true });

      // Calculate totals
      const totals = (rows || []).reduce((acc, row) => ({
        new_users:      (acc.new_users      || 0) + (row.new_users      || 0),
        new_listings:   (acc.new_listings   || 0) + (row.new_listings   || 0),
        orders:         (acc.orders         || 0) + (row.orders         || 0),
        gmv:            (acc.gmv            || 0) + (row.gmv            || 0),
        platform_fees:  (acc.platform_fees  || 0) + (row.platform_fees  || 0),
        barter_trades:  (acc.barter_trades  || 0) + (row.barter_trades  || 0),
        affiliate_clicks:(acc.affiliate_clicks||0)+ (row.affiliate_clicks||0),
      }), {});

      return { statusCode: 200, headers: h, body: JSON.stringify({ rows: rows || [], totals, days: parseInt(days) }) };
    } catch (e) {
      return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
    }
  }

  // ── RUN DAILY AGGREGATION JOB ─────────────────────────────
  if (event.httpMethod === 'POST') {
    try {
      const today     = new Date();
      const dateStr   = today.toISOString().split('T')[0];
      const yesterday = new Date(today - 24 * 60 * 60 * 1000).toISOString();

      // Run all queries in parallel
      const [
        usersRes, listingsRes, ordersRes,
        barterRes, affClicksRes, affImpRes,
        planRes,
      ] = await Promise.all([
        // New users today
        sb.from('profiles').select('id, vendor_plan', { count: 'exact', head: false }).gte('created_at', yesterday),
        // New listings today
        sb.from('listings').select('id, category', { count: 'exact', head: false }).gte('created_at', yesterday),
        // Orders today
        sb.from('orders').select('id, amount_total, platform_fee, vendor_plan').gte('created_at', yesterday),
        // Barter trades today
        sb.from('barter_transactions').select('id, fmv_a, fmv_b').gte('created_at', yesterday).eq('status', 'completed'),
        // Affiliate clicks today
        sb.from('affiliate_clicks').select('id, program').gte('clicked_at', yesterday),
        // Affiliate impressions today
        sb.from('affiliate_impressions').select('id').gte('created_at', yesterday),
        // Revenue by plan
        sb.from('orders').select('vendor_plan, amount_total, platform_fee').gte('created_at', yesterday),
      ]);

      const orders      = ordersRes.data  || [];
      const barters     = barterRes.data  || [];
      const affClicks   = affClicksRes.data || [];
      const listings    = listingsRes.data || [];
      const newUsers    = usersRes.data   || [];

      // Aggregate
      const gmv          = orders.reduce((s, o) => s + (o.amount_total || 0), 0);
      const platformFees = orders.reduce((s, o) => s + (o.platform_fee || 0), 0);
      const barterFmv    = barters.reduce((s, b) => s + (b.fmv_a || 0) + (b.fmv_b || 0), 0);

      // Top categories
      const categoryCounts = {};
      listings.forEach(l => { categoryCounts[l.category || 'Other'] = (categoryCounts[l.category || 'Other'] || 0) + 1; });
      const topCategories = Object.entries(categoryCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([cat, count]) => ({ category: cat, count }));

      // Revenue by plan
      const revenueByPlan = {};
      orders.forEach(o => {
        revenueByPlan[o.vendor_plan || 'free'] = (revenueByPlan[o.vendor_plan || 'free'] || 0) + (o.platform_fee || 0);
      });

      // Affiliate by program
      const affByProgram = {};
      affClicks.forEach(c => { affByProgram[c.program] = (affByProgram[c.program] || 0) + 1; });

      // Save to analytics_daily (upsert so re-running is safe)
      await sb.from('analytics_daily').upsert({
        date:             dateStr,
        new_users:        newUsers.length,
        new_listings:     listings.length,
        orders:           orders.length,
        gmv:              parseFloat(gmv.toFixed(2)),
        platform_fees:    parseFloat(platformFees.toFixed(2)),
        barter_trades:    barters.length,
        barter_fmv:       parseFloat(barterFmv.toFixed(2)),
        affiliate_clicks: affClicks.length,
        affiliate_impressions: affImpRes.data?.length || 0,
        top_categories:   JSON.stringify(topCategories),
        revenue_by_plan:  JSON.stringify(revenueByPlan),
        affiliate_by_program: JSON.stringify(affByProgram),
        created_at:       new Date().toISOString(),
      }, { onConflict: 'date' });

      return {
        statusCode: 200, headers: h,
        body: JSON.stringify({
          date: dateStr,
          newUsers: newUsers.length,
          newListings: listings.length,
          orders: orders.length,
          gmv: gmv.toFixed(2),
          platformFees: platformFees.toFixed(2),
          barterTrades: barters.length,
          affiliateClicks: affClicks.length,
        }),
      };
    } catch (e) {
      console.error(e);
      return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
    }
  }

  return { statusCode: 405, headers: h, body: JSON.stringify({ error: 'Method not allowed' }) };
};
