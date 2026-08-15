// ═══════════════════════════════════════════════════════════════
// The Swap Yard — Price Drop Alerts
// File: netlify/functions/price-drop-alerts.js
// Schedule: run daily via Netlify scheduled function
// ═══════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    // Find all wishlists where price has dropped
    const { data: alerts } = await sb
      .from('wishlists')
      .select(`
        user_id,
        listing_id,
        price_at_save,
        notify_drop,
        listing:listings(title, price_usd, cover_image, city),
        user:profiles(email, display_name)
      `)
      .eq('notify_drop', true)
      .not('price_at_save', 'is', null);

    if (!alerts || !alerts.length) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ sent: 0, message: 'No alerts needed' }) };
    }

    let sent = 0;

    for (const alert of alerts) {
      const listing = alert.listing;
      const user    = alert.user;
      if (!listing || !user || !user.email) continue;

      // Check if price actually dropped
      const savedPrice   = parseFloat(alert.price_at_save);
      const currentPrice = parseFloat(listing.price_usd);
      if (isNaN(savedPrice) || isNaN(currentPrice)) continue;
      if (currentPrice >= savedPrice) continue;

      const drop    = (savedPrice - currentPrice).toFixed(0);
      const pct     = Math.round((drop / savedPrice) * 100);
      const name    = user.display_name || user.email.split('@')[0];
      const appUrl  = 'https://theswapyard.com/mobile.html';

      // Send via Resend
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from:    'Swap Yard <alerts@theswapyard.com>',
          to:      [user.email],
          subject: `Price dropped ${pct}% on "${listing.title}"`,
          html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5ead8;font-family:'Figtree',system-ui,sans-serif">
  <div style="max-width:480px;margin:0 auto;padding:32px 16px">
    <!-- Header -->
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:24px">
      <div style="width:10px;height:10px;border-radius:50%;background:#8fa073"></div>
      <span style="font-size:17px;font-weight:700;color:#2e2b25">Swap Yard</span>
    </div>
    <!-- Card -->
    <div style="background:#f9f4ed;border:1px solid rgba(32,30,29,.14);border-radius:24px;overflow:hidden;margin-bottom:20px">
      ${listing.cover_image
        ? `<img src="${listing.cover_image}" style="width:100%;height:200px;object-fit:cover">`
        : `<div style="height:120px;background:#eee7db;display:flex;align-items:center;justify-content:center;font-size:3rem">📦</div>`
      }
      <div style="padding:20px">
        <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#8fa073;font-weight:700;margin-bottom:8px">
          Price Drop Alert ↓ ${pct}% off
        </div>
        <div style="font-size:20px;font-weight:700;color:#201e1d;margin-bottom:8px;line-height:1.2">
          ${listing.title}
        </div>
        <div style="display:flex;align-items:baseline;gap:12px;margin-bottom:16px">
          <span style="font-size:26px;font-weight:700;color:#c67139">$${currentPrice}</span>
          <span style="font-size:16px;color:#82796a;text-decoration:line-through">$${savedPrice}</span>
          <span style="font-size:13px;font-weight:700;background:#f0fae1;color:#3d472b;padding:3px 10px;border-radius:999px">
            Save $${drop}
          </span>
        </div>
        ${listing.city ? `<div style="font-size:13px;color:#82796a;margin-bottom:16px">📍 ${listing.city}</div>` : ''}
        <a href="${appUrl}" style="display:block;text-align:center;background:#c67139;color:#fff;padding:14px;border-radius:999px;font-size:15px;font-weight:700;text-decoration:none">
          View Listing →
        </a>
      </div>
    </div>
    <!-- Footer -->
    <div style="text-align:center;font-size:12px;color:#82796a;line-height:1.6">
      Hi ${name} — you saved this listing at $${savedPrice}.<br>
      <a href="${appUrl}" style="color:#8c491a">Open app</a> ·
      <a href="https://theswapyard.com/terms.html" style="color:#82796a">Unsubscribe</a>
    </div>
  </div>
</body>
</html>`,
        }),
      });

      if (emailRes.ok) {
        sent++;
        // Update last_alerted so we don't spam
        await sb.from('wishlists')
          .update({ last_alerted: new Date().toISOString() })
          .eq('user_id', alert.user_id)
          .eq('listing_id', alert.listing_id);
      }
    }

    return {
      statusCode: 200,
      headers: h,
      body: JSON.stringify({ sent, checked: alerts.length }),
    };

  } catch (e) {
    console.error('Price drop alerts error:', e);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};
