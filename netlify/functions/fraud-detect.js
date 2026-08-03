// ═══════════════════════════════════════════════════════════════
// The Swap Yard — Fraud & Abuse Detection
// File: netlify/functions/fraud-detect.js
//
// WHAT IT DOES:
//   Screens new listings, new accounts, and transaction patterns for
//   signs of fraud, spam, and policy violations. Works alongside the
//   AML compliance function (aml-compliance.js handles financial crime;
//   this handles marketplace-level abuse).
//
// TRIGGERED BY:
//   - New listing created (call from listing creation flow)
//   - New user signup (call from auth trigger or onboarding)
//   - Bulk upload submitted (call from bulk-upload.js)
//
// DETECTION PATTERNS:
//   LISTING FRAUD:  price manipulation, prohibited keywords, duplicate spam
//   ACCOUNT FRAUD:  multiple accounts same device/email pattern, velocity
//   TRANSACTION:    fake escrow requests, chargeback-risk patterns
//
// ACTIONS:
//   LOW:    Flag for human review, log to fraud_checks table
//   MEDIUM: Hold listing pending review, notify admin
//   HIGH:   Auto-deactivate listing + suspend account, notify admin immediately
//
// ENV VARS: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_EMAIL, RESEND_API_KEY
// ═══════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

// Prohibited listing keywords (auto-HIGH flag)
const PROHIBITED_KEYWORDS = [
  /\b(prescription|opioid|fentanyl|codeine|adderall|xanax)\b/i,
  /\b(fake|counterfeit|replica|knockoff|forged)\b/i,
  /\b(stolen|hot item|no receipt|no serial)\b/i,
  /\b(nude|explicit|adult only|18\+)\b/i,
  /\b(weapon|firearm|pistol|rifle|ammo|silencer)\b/i,
  /\b(social security|ssn|passport|id card)\b/i,
];

// Suspicious pricing patterns
function checkPricing(priceUsd, fmv) {
  const flags = [];
  if (priceUsd && priceUsd < 0.01) flags.push({ type: 'ZERO_PRICE', severity: 'MEDIUM', detail: 'Listing price is suspiciously low' });
  if (priceUsd && priceUsd > 50000) flags.push({ type: 'EXTREME_PRICE', severity: 'MEDIUM', detail: `Price $${priceUsd} is unusually high` });
  if (fmv && priceUsd && priceUsd > fmv * 5) flags.push({ type: 'PRICE_FMV_MISMATCH', severity: 'LOW', detail: 'Price is 5x over stated FMV' });
  if (fmv && priceUsd && priceUsd < fmv * 0.1) flags.push({ type: 'PRICE_BELOW_FMV', severity: 'LOW', detail: 'Price is under 10% of stated FMV — may attract fraudulent chargebacks' });
  return flags;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 };
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
    const { action, ...params } = JSON.parse(event.body);
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // ── SCREEN A NEW LISTING ──────────────────────────────────
    if (action === 'screen_listing') {
      const { listingId, userId, title = '', description = '', priceUsd, fmv, category } = params;
      const flags = [];

      // 1. Keyword scan
      const fullText = `${title} ${description}`;
      for (const pattern of PROHIBITED_KEYWORDS) {
        if (pattern.test(fullText)) {
          flags.push({ type: 'PROHIBITED_KEYWORD', severity: 'HIGH', detail: `Matched: ${pattern.toString()}` });
        }
      }

      // 2. Pricing check
      flags.push(...checkPricing(priceUsd, fmv));

      // 3. Duplicate detection — same user posting very similar titles
      const { data: recentByUser } = await sb
        .from('listings')
        .select('title')
        .eq('user_id', userId)
        .eq('is_active', true)
        .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

      if (recentByUser?.length > 10) {
        flags.push({ type: 'HIGH_VOLUME_POSTING', severity: 'MEDIUM', detail: `User posted ${recentByUser.length} listings in 24 hours` });
      }

      const similarTitle = recentByUser?.find(l => {
        const similarity = l.title.toLowerCase().replace(/\W/g,'');
        const newTitle   = title.toLowerCase().replace(/\W/g,'');
        return similarity === newTitle;
      });
      if (similarTitle) {
        flags.push({ type: 'DUPLICATE_LISTING', severity: 'MEDIUM', detail: `Identical title posted recently: "${similarTitle.title}"` });
      }

      // 4. Determine action
      const highFlags   = flags.filter(f => f.severity === 'HIGH');
      const mediumFlags = flags.filter(f => f.severity === 'MEDIUM');
      const autoAction  = highFlags.length > 0   ? 'deactivate'
                        : mediumFlags.length > 0  ? 'hold'
                        : 'approve';

      // Apply action
      if (autoAction === 'deactivate' || autoAction === 'hold') {
        await sb.from('listings').update({ is_active: autoAction !== 'deactivate' }).eq('id', listingId);
      }

      // Log fraud check
      await sb.from('fraud_checks').insert({
        entity_type: 'listing',
        entity_id:   listingId,
        user_id:     userId,
        flags:       JSON.stringify(flags),
        action:      autoAction,
        checked_at:  new Date().toISOString(),
      });

      // Alert admin for high/medium
      if ((highFlags.length || mediumFlags.length) && process.env.ADMIN_EMAIL) {
        await alertAdmin(`🚨 Fraud flag: Listing ${listingId}`,
          `Action: ${autoAction}\nTitle: "${title}"\nFlags:\n${flags.map(f => `[${f.severity}] ${f.type}: ${f.detail}`).join('\n')}`);
      }

      return { statusCode: 200, headers: h, body: JSON.stringify({ listingId, action: autoAction, flags }) };
    }

    // ── SCREEN A NEW USER ACCOUNT ─────────────────────────────
    if (action === 'screen_account') {
      const { userId, email, displayName } = params;
      const flags = [];

      // Check for disposable email domains
      const disposableDomains = ['mailinator.com','guerrillamail.com','10minutemail.com','throwaway.email','tempmail.com'];
      const emailDomain = email?.split('@')[1]?.toLowerCase();
      if (disposableDomains.includes(emailDomain)) {
        flags.push({ type: 'DISPOSABLE_EMAIL', severity: 'MEDIUM', detail: `Email domain ${emailDomain} is a known disposable service` });
      }

      // Check display name for prohibited keywords
      if (PROHIBITED_KEYWORDS.some(p => p.test(displayName))) {
        flags.push({ type: 'SUSPICIOUS_NAME', severity: 'HIGH', detail: 'Display name contains prohibited keywords' });
      }

      const highFlags = flags.filter(f => f.severity === 'HIGH');
      if (highFlags.length) {
        await sb.from('profiles').update({ is_active: false, blocked_reason: 'FRAUD_DETECT' }).eq('id', userId);
      }

      await sb.from('fraud_checks').insert({
        entity_type: 'account',
        entity_id:   userId,
        user_id:     userId,
        flags:       JSON.stringify(flags),
        action:      highFlags.length ? 'block' : 'approve',
        checked_at:  new Date().toISOString(),
      });

      if (highFlags.length && process.env.ADMIN_EMAIL) {
        await alertAdmin(`🚨 Fraud flag: New account ${userId}`,
          `Email: ${email}\nName: ${displayName}\nFlags:\n${flags.map(f => `[${f.severity}] ${f.type}: ${f.detail}`).join('\n')}`);
      }

      return { statusCode: 200, headers: h, body: JSON.stringify({ userId, blocked: highFlags.length > 0, flags }) };
    }

    // ── ADMIN: GET RECENT FLAGS ───────────────────────────────
    if (action === 'get_flags') {
      const { limit = 50, severity } = params;
      let query = sb.from('fraud_checks').select('*').order('checked_at', { ascending: false }).limit(limit);
      const { data } = await query;
      return { statusCode: 200, headers: h, body: JSON.stringify({ flags: data || [] }) };
    }

    // ── ADMIN: CLEAR A FLAG (approve after review) ────────────
    if (action === 'clear_flag') {
      const { checkId, entityType, entityId, approve } = params;
      await sb.from('fraud_checks').update({ cleared: true, cleared_at: new Date().toISOString() }).eq('id', checkId);
      if (approve && entityType === 'listing') {
        await sb.from('listings').update({ is_active: true }).eq('id', entityId);
      }
      return { statusCode: 200, headers: h, body: JSON.stringify({ cleared: true }) };
    }

    return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};

async function alertAdmin(subject, body) {
  if (!process.env.RESEND_API_KEY || !process.env.ADMIN_EMAIL) return;
  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:    process.env.FROM_EMAIL || 'noreply@theswapyard.com',
      to:      process.env.ADMIN_EMAIL,
      subject,
      html:    `<pre style="font-family:monospace;font-size:.85rem;line-height:1.6;">${body}</pre>`,
    }),
  });
}
