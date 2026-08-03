// ═══════════════════════════════════════════════════════════════
// The Swap Yard — Listing Expiry Manager
// File: netlify/functions/listing-expire.js
//
// SETUP — Schedule in netlify.toml:
//   [functions."listing-expire"]
//     schedule = "0 6 * * *"   ← runs every day at 6am UTC
//
// WHAT IT DOES:
//   Phase 1 (day 80): Send "your listing expires in 10 days" warning email
//   Phase 2 (day 90): Auto-deactivate listing + send renewal email with 1-click repost link
//   Phase 3 (day 97): Final reminder email for deactivated listings
//
// LISTING LIFESPAN:
//   Free plan:          90 days
//   Trader Pro:         180 days
//   Verified Vendor:    365 days
//   Business:           Never expires
//   Boosted listings:   Never expires while boost is active
//
// ENV VARS: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, FROM_EMAIL, URL
// ═══════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

const PLAN_LIFESPANS_DAYS = {
  free:             90,
  trader_pro:      180,
  verified_vendor: 365,
  business:        Infinity,
};

function getExpiryDays(vendorPlan) {
  return PLAN_LIFESPANS_DAYS[vendorPlan] || 90;
}

exports.handler = async (event) => {
  const h = { 'Content-Type': 'application/json' };

  try {
    const sb      = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const baseUrl = process.env.URL || 'https://theswapyard.com';
    const now     = new Date();

    let warnings = 0;
    let expired  = 0;
    let reminders = 0;

    // Load all active listings with owner plan info
    const { data: listings } = await sb
      .from('listings')
      .select('id, title, emoji, created_at, is_active, is_boosted, boost_expires_at, user_id, profiles(email, display_name, vendor_plan)')
      .eq('is_active', true);

    if (!listings?.length) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ warnings, expired, reminders }) };
    }

    for (const listing of listings) {
      const vendorPlan = listing.profiles?.vendor_plan || 'free';
      if (vendorPlan === 'business') continue;

      // Skip if listing is actively boosted
      if (listing.is_boosted && listing.boost_expires_at && new Date(listing.boost_expires_at) > now) continue;

      const createdAt   = new Date(listing.created_at);
      const ageInDays   = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));
      const expiryDays  = getExpiryDays(vendorPlan);
      const daysLeft    = expiryDays - ageInDays;
      const userEmail   = listing.profiles?.email;
      const userName    = listing.profiles?.display_name || 'there';
      const repostUrl   = `${baseUrl}/index.html?repost=${listing.id}`;

      // Phase 1: Warning at 10 days remaining
      if (daysLeft === 10 && userEmail) {
        await sendEmail(userEmail, `⏰ Your listing "${listing.title}" expires in 10 days`, `
          <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:2rem;">
            <div style="font-weight:900;font-size:1.1rem;margin-bottom:1.25rem;"><span style="color:#7c3aed">The Swap</span> Yard</div>
            <h2 style="font-size:1rem;font-weight:800;margin-bottom:.75rem;">⏰ Listing Expiring Soon</h2>
            <p style="color:#374151;font-size:.85rem;margin-bottom:1rem;">Hi ${userName} — your listing <strong>${listing.emoji} ${listing.title}</strong> will be automatically deactivated in <strong>10 days</strong>.</p>
            <p style="color:#374151;font-size:.85rem;margin-bottom:1.25rem;">To keep it live, simply visit your dashboard and repost it — your description and photos are saved.</p>
            <a href="${baseUrl}/vendor-dashboard.html" style="display:inline-block;background:#7c3aed;color:#fff;padding:.75rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;font-size:.85rem;">Keep My Listing Active →</a>
            <p style="font-size:.72rem;color:#9ca3af;margin-top:1rem;">Upgrade to Trader Pro for 180-day listings, or Business for listings that never expire.</p>
          </div>`);
        warnings++;
      }

      // Phase 2: Deactivate at expiry day
      if (daysLeft <= 0) {
        await sb.from('listings').update({ is_active: false }).eq('id', listing.id);
        if (userEmail) {
          await sendEmail(userEmail, `📦 Your listing "${listing.title}" has expired`, `
            <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:2rem;">
              <div style="font-weight:900;font-size:1.1rem;margin-bottom:1.25rem;"><span style="color:#7c3aed">The Swap</span> Yard</div>
              <h2 style="font-size:1rem;font-weight:800;margin-bottom:.75rem;">📦 Listing Deactivated</h2>
              <p style="color:#374151;font-size:.85rem;margin-bottom:1rem;">Hi ${userName} — your listing <strong>${listing.emoji} ${listing.title}</strong> has been deactivated after ${expiryDays} days.</p>
              <p style="color:#374151;font-size:.85rem;margin-bottom:1.25rem;">Repost it in one click — all your original details are saved.</p>
              <a href="${repostUrl}" style="display:inline-block;background:#059669;color:#fff;padding:.75rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;font-size:.85rem;margin-right:.5rem;">🔄 Repost Listing</a>
              <a href="${baseUrl}/vendor-dashboard.html" style="display:inline-block;background:rgba(124,58,237,.1);color:#7c3aed;border:1px solid rgba(124,58,237,.25);padding:.75rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;font-size:.85rem;">Dashboard</a>
            </div>`);
        }
        expired++;
      }
    }

    // Phase 3: Remind about deactivated listings (deactivated 7 days ago, not reposted)
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: deadListings } = await sb
      .from('listings')
      .select('id, title, emoji, updated_at, profiles(email, display_name)')
      .eq('is_active', false)
      .gte('updated_at', sevenDaysAgo)
      .lte('updated_at', new Date(now - 6 * 24 * 60 * 60 * 1000).toISOString());

    for (const listing of deadListings || []) {
      const userEmail = listing.profiles?.email;
      const userName  = listing.profiles?.display_name || 'there';
      if (!userEmail) continue;
      await sendEmail(userEmail, `🔔 Reminder: "${listing.title}" is still inactive`, `
        <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:2rem;">
          <div style="font-weight:900;font-size:1.1rem;margin-bottom:1.25rem;"><span style="color:#7c3aed">The Swap</span> Yard</div>
          <p style="color:#374151;font-size:.85rem;">Hi ${userName} — just a reminder that <strong>${listing.emoji} ${listing.title}</strong> is still deactivated. Repost it to get back in front of buyers.</p>
          <a href="${baseUrl}/vendor-dashboard.html" style="display:inline-block;margin-top:1rem;background:#7c3aed;color:#fff;padding:.75rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;font-size:.85rem;">Repost Now →</a>
        </div>`);
      reminders++;
    }

    return {
      statusCode: 200, headers: h,
      body: JSON.stringify({ warnings, expired, reminders, total: listings.length }),
    };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};

async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY) return;
  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.FROM_EMAIL || 'noreply@theswapyard.com', to, subject, html }),
  });
}
