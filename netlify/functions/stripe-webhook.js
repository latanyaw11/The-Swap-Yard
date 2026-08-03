// ═══════════════════════════════════════════════════════════════
// SwapYard — Stripe Webhook Handler
// File: netlify/functions/stripe-webhook.js
//
// SETUP:
// 1. Netlify env vars:
//    STRIPE_SECRET_KEY         → sk_live_...
//    STRIPE_WEBHOOK_SECRET     → whsec_... (from Stripe Dashboard → Webhooks)
//    SUPABASE_URL              → your project URL
//    SUPABASE_SERVICE_ROLE_KEY → service_role key (NOT anon — has write access)
//
// 2. In Stripe Dashboard → Webhooks → Add endpoint:
//    URL: https://swapyard.us.com/.netlify/functions/stripe-webhook
//    Events: checkout.session.completed, payment_intent.payment_failed
//
// WHAT THIS DOES:
//   Every time a payment completes, this runs automatically and:
//   - Creates an order record in Supabase
//   - Updates vendor revenue totals
//   - Sends confirmation (you can add email here via SendGrid/Resend)
// ═══════════════════════════════════════════════════════════════

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const sig    = event.headers['stripe-signature'];

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(event.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('Webhook signature verification failed:', e.message);
    return { statusCode: 400, body: `Webhook Error: ${e.message}` };
  }

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // ── Payment completed successfully ──
  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    const meta    = session.metadata || {};

    const amountTotal      = session.amount_total / 100;          // dollars
    const platformFee      = parseFloat(meta.platformFeeUsd || 0);
    const vendorEarnings   = amountTotal - platformFee;

    // 1. Create order record
    await sb.from('orders').insert({
      listing_id:             meta.listingId,
      stripe_session_id:      session.id,
      buyer_email:            session.customer_email,
      vendor_stripe_account:  meta.vendorStripeAccountId,
      amount_total:           amountTotal,
      platform_fee:           platformFee,
      vendor_earnings:        vendorEarnings,
      status:                 'paid',
      vendor_plan:            meta.vendorPlan,
      created_at:             new Date().toISOString(),
    });

    // 2. Update vendor revenue totals (upsert into vendor_stats table)
    const { data: existing } = await sb
      .from('vendor_stats')
      .select('*')
      .eq('stripe_account_id', meta.vendorStripeAccountId)
      .single();

    if (existing) {
      await sb.from('vendor_stats').update({
        total_revenue:    (existing.total_revenue || 0) + vendorEarnings,
        total_orders:     (existing.total_orders  || 0) + 1,
        last_sale_at:     new Date().toISOString(),
      }).eq('stripe_account_id', meta.vendorStripeAccountId);
    } else {
      await sb.from('vendor_stats').insert({
        stripe_account_id: meta.vendorStripeAccountId,
        total_revenue:     vendorEarnings,
        total_orders:      1,
        last_sale_at:      new Date().toISOString(),
      });
    }

    console.log(`Order created: listing ${meta.listingId}, vendor earned $${vendorEarnings}`);
  }

  // ── Payment failed ──
  if (stripeEvent.type === 'payment_intent.payment_failed') {
    const pi = stripeEvent.data.object;
    await sb.from('orders').insert({
      stripe_session_id: pi.id,
      status:            'failed',
      created_at:        new Date().toISOString(),
    });
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
