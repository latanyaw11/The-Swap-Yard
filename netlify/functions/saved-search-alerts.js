// ═══════════════════════════════════════════════════════════════
// The Swap Yard — Saved Search Alert Runner
// File: netlify/functions/saved-search-alerts.js
//
// SETUP — Run on a schedule via Netlify Scheduled Functions:
//   Add to netlify.toml:
//
//   [functions."saved-search-alerts"]
//     schedule = "0 8 * * *"   ← runs every day at 8am UTC
//
// WHAT IT DOES:
//   1. Loads all active saved searches from Supabase
//   2. For each search, queries listings created since last alert
//   3. If matches found → sends email + push notification
//   4. Updates last_alert timestamp so next run only checks new listings
//
// ENV VARS NEEDED:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY, FROM_EMAIL, URL
// ═══════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const h = { 'Content-Type': 'application/json' };
  const isScheduled = event.httpMethod === 'POST' && event.headers['x-netlify-event'] === 'schedule';
  const isManual    = event.httpMethod === 'GET';

  if (!isScheduled && !isManual) {
    return { statusCode: 405, headers: h, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // Load all active saved searches with user profile
    const { data: searches } = await sb
      .from('saved_searches')
      .select('*, profiles(email, display_name)')
      .eq('is_active', true);

    if (!searches?.length) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ processed: 0, alertsSent: 0 }) };
    }

    let alertsSent = 0;
    let processed  = 0;

    for (const search of searches) {
      processed++;
      const userEmail = search.profiles?.email;
      if (!userEmail) continue;

      // Only check listings created since the last alert (or last 24h if never alerted)
      const since = search.last_alert
        ? new Date(search.last_alert).toISOString()
        : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      // Build query from saved search params
      let query = sb.from('listings')
        .select('id, title, emoji, price_usd, category, city, state, seller_name, created_at')
        .eq('is_active', true)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(5);

      // Apply saved filters
      if (search.query?.trim()) {
        query = query.textSearch('search_vector', search.query.trim(), { type: 'websearch' });
      }
      const filters = search.filters ? (typeof search.filters === 'string' ? JSON.parse(search.filters) : search.filters) : {};
      if (filters.category) query = query.eq('category', filters.category);
      if (filters.type)     query = query.eq('type', filters.type);
      if (filters.minPrice) query = query.gte('price_usd', filters.minPrice);
      if (filters.maxPrice) query = query.lte('price_usd', filters.maxPrice);

      const { data: matches } = await query;
      if (!matches?.length) continue;

      // Build email
      const baseUrl   = process.env.URL || 'https://theswapyard.com';
      const searchUrl = `${baseUrl}/index.html?q=${encodeURIComponent(search.query || '')}&category=${encodeURIComponent(filters.category || '')}`;

      const listingsHtml = matches.map(l => `
        <div style="display:flex;align-items:center;gap:.75rem;padding:.75rem;background:linear-gradient(135deg,rgba(5,150,105,.06),rgba(5,150,105,.02));border:1px solid rgba(5,150,105,.2);border-radius:8px;margin-bottom:.5rem;">
          <span style="font-size:1.5rem;">${l.emoji || '📦'}</span>
          <div style="flex:1;">
            <div style="font-weight:700;font-size:.88rem;color:#111827;">${l.title}</div>
            <div style="font-size:.75rem;color:#374151;">${l.city || ''}, ${l.state || ''} · ${l.price_usd ? '$' + l.price_usd : 'Trade'}</div>
          </div>
          <a href="${baseUrl}/index.html" style="font-size:.72rem;font-weight:700;color:#7c3aed;text-decoration:none;">View →</a>
        </div>`).join('');

      const emailHtml = `
        <div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;padding:2rem;">
          <div style="font-size:1.2rem;font-weight:900;margin-bottom:1.5rem;">
            <span style="color:#7c3aed">The Swap</span> Yard
          </div>
          <h2 style="font-size:1.1rem;font-weight:800;color:#111827;margin-bottom:.5rem;">
            🔔 ${matches.length} new listing${matches.length > 1 ? 's' : ''} match${matches.length === 1 ? 'es' : ''} <em>${search.name || search.query || 'your saved search'}</em>
          </h2>
          <p style="color:#374151;font-size:.85rem;margin-bottom:1.25rem;">
            Hi ${search.profiles?.display_name || 'there'} — here's what's new since your last alert:
          </p>
          ${listingsHtml}
          <div style="margin-top:1.5rem;text-align:center;">
            <a href="${searchUrl}" style="display:inline-block;background:#7c3aed;color:#fff;padding:.75rem 1.75rem;border-radius:8px;text-decoration:none;font-weight:700;font-size:.88rem;">
              See All Matches →
            </a>
          </div>
          <p style="font-size:.7rem;color:#9ca3af;margin-top:1.5rem;text-align:center;">
            The Swap Yard · <a href="${baseUrl}/vendor-dashboard.html" style="color:#7c3aed;">Manage alerts</a>
          </p>
        </div>`;

      // Send email via Resend
      if (process.env.RESEND_API_KEY) {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from:    process.env.FROM_EMAIL || 'noreply@theswapyard.com',
            to:      userEmail,
            subject: `🔔 ${matches.length} new match${matches.length !== 1 ? 'es' : ''} for "${search.name || 'your saved search'}"`,
            html:    emailHtml,
          }),
        });

        if (res.ok) {
          alertsSent++;
          // Update last_alert so next run only checks newer listings
          await sb.from('saved_searches').update({ last_alert: new Date().toISOString() }).eq('id', search.id);

          // Also send push notification
          if (process.env.VAPID_PUBLIC_KEY) {
            await fetch(`${baseUrl}/.netlify/functions/push-notify`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                userId: search.user_id,
                type:   'listing_match',
                data:   { searchName: search.name || search.query, count: matches.length },
              }),
            }).catch(() => {});
          }
        }
      }
    }

    return {
      statusCode: 200, headers: h,
      body: JSON.stringify({ processed, alertsSent, message: `Processed ${processed} searches, sent ${alertsSent} alerts` }),
    };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};
