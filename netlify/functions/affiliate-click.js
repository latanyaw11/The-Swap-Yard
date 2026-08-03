// ═══════════════════════════════════════════════════════════════
// The Swap Yard — Affiliate Click Tracker
// File: netlify/functions/affiliate-click.js
//
// Called every time a user clicks an affiliate link.
// Logs the click so you can see which listings drive revenue.
// ═══════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 };
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
    const { listingId, userId, program, url, category } = JSON.parse(event.body);

    if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      await sb.from('affiliate_clicks').insert({
        listing_id:  listingId || null,
        user_id:     userId    || null,
        program,
        destination: url,
        category,
        clicked_at:  new Date().toISOString(),
      });
    }

    return { statusCode: 200, headers: h, body: JSON.stringify({ tracked: true }) };
  } catch (e) {
    return { statusCode: 200, headers: h, body: JSON.stringify({ tracked: false }) };
  }
};
