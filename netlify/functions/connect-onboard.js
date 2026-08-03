// ═══════════════════════════════════════════════════════════════
// SwapYard — Stripe Connect Vendor Onboarding
// File: netlify/functions/connect-onboard.js
//
// SETUP:
// 1. In Stripe Dashboard → Connect → Settings
//    Set your platform name, brand color, icon
// 2. Netlify env vars needed:
//    STRIPE_SECRET_KEY  → sk_live_... or sk_test_...
//    URL                → https://swapyard.us.com (auto-set by Netlify)
//
// FLOW:
//   Vendor clicks "Become a Vendor" →
//   We create a Stripe Connect account for them →
//   Redirect them to Stripe's hosted onboarding →
//   Stripe collects bank details, ID, tax info →
//   Stripe redirects back to SwapYard dashboard
// ═══════════════════════════════════════════════════════════════

const Stripe = require('stripe');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 };
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const { email, userId, vendorName } = JSON.parse(event.body);

    // 1. Create a Stripe Express account for this vendor
    //    Express = fastest onboarding, Stripe handles all compliance
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'US',
      email,
      capabilities: {
        card_payments: { requested: true },
        transfers:     { requested: true },
      },
      business_profile: {
        name: vendorName || email,
        url:  process.env.URL || 'https://swapyard.us.com',
        mcc:  '5999', // Miscellaneous retail — matches SwapYard's marketplace model
      },
      metadata: { swapyard_user_id: userId },
    });

    // 2. Create the onboarding link (expires in 1 hour)
    // Always returns to vendor dashboard so tax status panel updates correctly
    const baseUrl = process.env.URL || 'https://theswapyard.com';
    const accountLink = await stripe.accountLinks.create({
      account:     account.id,
      refresh_url: `${baseUrl}/vendor-dashboard.html?stripe=refresh`,
      return_url:  `${baseUrl}/vendor-dashboard.html?stripe=success&account=${account.id}`,
      type:        'account_onboarding',
    });

    // 3. Return both the Stripe account ID (save to your Supabase users table)
    //    and the onboarding URL to redirect the vendor to
    return {
      statusCode: 200,
      headers: h,
      body: JSON.stringify({
        stripeAccountId: account.id,      // ← SAVE THIS to Supabase: profiles.stripe_account_id
        onboardingUrl:   accountLink.url, // ← REDIRECT vendor here
      }),
    };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};
