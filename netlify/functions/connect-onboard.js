// ═══════════════════════════════════════════════════════════════
// SwapYard — Stripe Connect Vendor Onboarding
// File: netlify/functions/connect-onboard.js
//
// SETUP:
// 1. In Stripe Dashboard → Connect → Settings
//    Set your platform name, brand color, icon
// 2. Netlify env vars needed:
//    STRIPE_SECRET_KEY  → sk_live_... or sk_test_...
//    URL                → https://theswapyard.com (auto-set by Netlify)
//
// FLOW:
//   Seller taps "Set up card payouts" in the app →
//   create_account: we create a Stripe Connect Express account for them,
//     save its id to profiles.stripe_account_id, and hand back an
//     onboarding link →
//   Seller finishes Stripe's hosted onboarding (bank details, ID, tax info) →
//   Stripe redirects back to /mobile.html?stripe_connect=success&account=... →
//   The app calls check_status to confirm onboarding actually completed
//   (a bounced-back redirect does NOT by itself mean the seller finished —
//   Stripe fires the return_url either way) before marking them as ready
//   to receive escrow payments.
// ═══════════════════════════════════════════════════════════════

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 };
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const sb     = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { action, ...params } = JSON.parse(event.body);
    const baseUrl = process.env.URL || 'https://theswapyard.com';

    // ── CREATE ACCOUNT + ONBOARDING LINK ───────────────────────
    if (!action || action === 'create_account') {
      const { email, userId, vendorName } = params;
      if (!userId || !email) {
        return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'userId and email are required' }) };
      }

      // Reuse an existing connected account if this seller already started
      // onboarding before, instead of creating a duplicate Stripe account.
      const { data: profile } = await sb.from('profiles').select('stripe_account_id').eq('id', userId).single();
      let accountId = profile && profile.stripe_account_id;

      if (!accountId) {
        const account = await stripe.accounts.create({
          type: 'express',
          country: 'US',
          email,
          capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
          business_profile: { name: vendorName || email, url: baseUrl, mcc: '5999' },
          metadata: { swapyard_user_id: userId },
        });
        accountId = account.id;
        await sb.from('profiles').update({ stripe_account_id: accountId }).eq('id', userId);
      }

      const accountLink = await stripe.accountLinks.create({
        account:     accountId,
        refresh_url: `${baseUrl}/mobile.html?stripe_connect=refresh`,
        return_url:  `${baseUrl}/mobile.html?stripe_connect=success&account=${accountId}`,
        type:        'account_onboarding',
      });

      return {
        statusCode: 200, headers: h,
        body: JSON.stringify({ stripeAccountId: accountId, onboardingUrl: accountLink.url }),
      };
    }

    // ── CHECK STATUS (call after the onboarding redirect returns) ─
    if (action === 'check_status') {
      const { userId, accountId } = params;
      let acctId = accountId;
      if (!acctId && userId) {
        const { data: profile } = await sb.from('profiles').select('stripe_account_id').eq('id', userId).single();
        acctId = profile && profile.stripe_account_id;
      }
      if (!acctId) return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'No connected account on file' }) };

      const account = await stripe.accounts.retrieve(acctId);
      const status = {
        accountId:       acctId,
        detailsSubmitted: !!account.details_submitted,
        chargesEnabled:   !!account.charges_enabled,
        payoutsEnabled:   !!account.payouts_enabled,
      };

      if (userId) {
        await sb.from('profiles').update({
          stripe_payouts_enabled: status.payoutsEnabled && status.chargesEnabled,
        }).eq('id', userId);
      }

      return { statusCode: 200, headers: h, body: JSON.stringify(status) };
    }

    return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};
