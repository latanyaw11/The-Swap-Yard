// ═══════════════════════════════════════════════════════════════
// The Swap Yard — Waitlist Manager
// File: netlify/functions/waitlist.js
//
// MANAGES WAITLISTS FOR:
//   certified_vendor   → Vendors wanting Verified Vendor status review
//   certification_[X]  → Specialist certification category waitlist
//   business_plan      → Interest in Business plan features
//   local_pickup_zone  → Notify when Safe Transaction Zones open in their city
//   early_access       → General early access / beta features
//
// ACTIONS:
//   join     → Add to waitlist, send confirmation email
//   status   → Check position and estimated wait time
//   invite   → Admin: send invite email to next N people on list
//   list     → Admin: view full waitlist for a type
//   remove   → Remove from waitlist (user-initiated or admin)
//
// ENV VARS: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, FROM_EMAIL, URL
// ═══════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

const WAITLIST_CONFIG = {
  certified_vendor: {
    label:      'Verified Vendor Program',
    confirmMsg: "You're on the Verified Vendor waitlist! We review applications monthly and will email you when it's your turn.",
    inviteMsg:  "Great news — you've been invited to apply for Verified Vendor status on The Swap Yard!",
    inviteUrl:  '/vendor-dashboard.html#verification',
  },
  business_plan: {
    label:      'Business Plan',
    confirmMsg: "You're on the Business Plan interest list. We'll reach out when we have availability and to discuss your needs.",
    inviteMsg:  "We'd love to discuss a Business Plan for The Swap Yard with you.",
    inviteUrl:  '/vendor-dashboard.html#settings',
  },
  local_pickup_zone: {
    label:      'Safe Transaction Zone',
    confirmMsg: "You're on the Safe Transaction Zone waitlist for your area. We'll notify you when a zone opens near you.",
    inviteMsg:  "A Safe Transaction Zone is now open near you!",
    inviteUrl:  '/terms.html#safety',
  },
  early_access: {
    label:      'Early Access Features',
    confirmMsg: "You're on our early access list! You'll be among the first to try new features before they launch publicly.",
    inviteMsg:  "You've been selected for early access to a new The Swap Yard feature!",
    inviteUrl:  '/',
  },
};

exports.handler = async (event) => {
  if (!['GET','POST','DELETE'].includes(event.httpMethod)) return { statusCode: 405 };
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const baseUrl = process.env.URL || 'https://theswapyard.com';

  try {
    const body   = event.httpMethod !== 'GET' ? JSON.parse(event.body || '{}') : {};
    const params = { ...event.queryStringParameters, ...body };
    const { action = 'join', type, userId, email, name, city, zip, notes, limit: inviteLimit = 5 } = params;

    const config = WAITLIST_CONFIG[type] || WAITLIST_CONFIG.early_access;

    // ── JOIN WAITLIST ─────────────────────────────────────────
    if (action === 'join') {
      if (!type || !email) return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'type and email required' }) };

      // Check if already on list
      const { data: existing } = await sb
        .from('waitlist')
        .select('id, position, status')
        .eq('type', type)
        .eq('email', email)
        .single();

      if (existing) {
        return { statusCode: 200, headers: h, body: JSON.stringify({ alreadyJoined: true, position: existing.position, status: existing.status }) };
      }

      // Get current count to determine position
      const { count } = await sb.from('waitlist').select('id', { count: 'exact', head: true }).eq('type', type).eq('status', 'waiting');
      const position  = (count || 0) + 1;

      // Add to waitlist
      const { data: entry } = await sb.from('waitlist').insert({
        type,
        user_id:    userId || null,
        email,
        name:       name  || null,
        city:       city  || null,
        zip:        zip   || null,
        notes:      notes || null,
        position,
        status:     'waiting',
        joined_at:  new Date().toISOString(),
      }).select().single();

      // Send confirmation email
      if (process.env.RESEND_API_KEY) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from:    process.env.FROM_EMAIL || 'noreply@theswapyard.com',
            to:      email,
            subject: `✅ You're on the ${config.label} waitlist — The Swap Yard`,
            html:    `
              <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:2rem;">
                <div style="font-weight:900;font-size:1.1rem;margin-bottom:1.25rem;"><span style="color:#7c3aed">The Swap</span> Yard</div>
                <h2 style="font-size:1rem;font-weight:800;margin-bottom:.75rem;">✅ You're on the list!</h2>
                <p style="color:#374151;font-size:.85rem;line-height:1.6;margin-bottom:1rem;">Hi ${name || 'there'} — ${config.confirmMsg}</p>
                <div style="background:linear-gradient(135deg,rgba(5,150,105,.07),rgba(5,150,105,.02));border:1px solid rgba(5,150,105,.2);border-radius:8px;padding:1rem;margin-bottom:1.25rem;font-size:.85rem;color:#374151;">
                  <strong>Your position:</strong> #${position} on the ${config.label} waitlist
                </div>
                <a href="${baseUrl}/vendor-dashboard.html" style="display:inline-block;background:#7c3aed;color:#fff;padding:.75rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;font-size:.85rem;">Visit Dashboard →</a>
                <p style="font-size:.7rem;color:#9ca3af;margin-top:1rem;">The Swap Yard · <a href="${baseUrl}" style="color:#7c3aed;">theswapyard.com</a></p>
              </div>`,
          }),
        });
      }

      return { statusCode: 200, headers: h, body: JSON.stringify({ joined: true, position, entryId: entry?.id }) };
    }

    // ── CHECK STATUS ──────────────────────────────────────────
    if (action === 'status') {
      const { data: entry } = await sb.from('waitlist').select('position, status, joined_at').eq('type', type).eq('email', email).single();
      if (!entry) return { statusCode: 404, headers: h, body: JSON.stringify({ found: false }) };

      const { count: ahead } = await sb.from('waitlist').select('id', { count: 'exact', head: true }).eq('type', type).eq('status', 'waiting').lt('position', entry.position);

      return { statusCode: 200, headers: h, body: JSON.stringify({ ...entry, aheadOfYou: ahead || 0 }) };
    }

    // ── ADMIN: SEND INVITES (POST with action=invite) ─────────
    if (action === 'invite') {
      const { data: next } = await sb
        .from('waitlist')
        .select('*')
        .eq('type', type)
        .eq('status', 'waiting')
        .order('position', { ascending: true })
        .limit(parseInt(inviteLimit));

      let invited = 0;
      for (const entry of next || []) {
        if (process.env.RESEND_API_KEY && entry.email) {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from:    process.env.FROM_EMAIL || 'noreply@theswapyard.com',
              to:      entry.email,
              subject: `🎉 Your invitation is ready — ${config.label} · The Swap Yard`,
              html:    `
                <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:2rem;">
                  <div style="font-weight:900;font-size:1.1rem;margin-bottom:1.25rem;"><span style="color:#7c3aed">The Swap</span> Yard</div>
                  <h2 style="font-size:1rem;font-weight:800;margin-bottom:.75rem;">🎉 Your Invitation is Ready</h2>
                  <p style="color:#374151;font-size:.85rem;line-height:1.6;margin-bottom:1.25rem;">Hi ${entry.name || 'there'} — ${config.inviteMsg}</p>
                  <a href="${baseUrl}${config.inviteUrl}" style="display:inline-block;background:#7c3aed;color:#fff;padding:.75rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:700;font-size:.85rem;">Accept Invitation →</a>
                </div>`,
            }),
          });
          await sb.from('waitlist').update({ status: 'invited', invited_at: new Date().toISOString() }).eq('id', entry.id);
          invited++;
        }
      }

      return { statusCode: 200, headers: h, body: JSON.stringify({ invited }) };
    }

    // ── ADMIN: LIST WAITLIST ──────────────────────────────────
    if (action === 'list') {
      const { data } = await sb.from('waitlist').select('*').eq('type', type).order('position', { ascending: true }).limit(200);
      return { statusCode: 200, headers: h, body: JSON.stringify({ entries: data || [], total: data?.length || 0 }) };
    }

    // ── REMOVE FROM WAITLIST ──────────────────────────────────
    if (action === 'remove' || event.httpMethod === 'DELETE') {
      await sb.from('waitlist').delete().eq('type', type).eq('email', email);
      return { statusCode: 200, headers: h, body: JSON.stringify({ removed: true }) };
    }

    return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};
