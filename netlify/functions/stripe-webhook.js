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
//    URL: https://theswapyard.com/.netlify/functions/stripe-webhook
//    Events to send:
//      checkout.session.completed          (legacy — premium-listing boosts)
//      payment_intent.amount_capturable_updated  (escrow: card authorized/held)
//      payment_intent.succeeded                  (escrow: captured/released)
//      payment_intent.payment_failed
//      payment_intent.canceled                   (authorization expired/canceled)
//
// WHAT THIS DOES:
//   - checkout.session.completed: records a paid order + updates vendor totals
//     (used by the hosted-checkout flow, e.g. premium-listing.js boosts)
//   - amount_capturable_updated: an escrow's card authorization succeeded —
//     flips escrows.status to 'funded' and starts the auto-release clock.
//     This is the authoritative signal, independent of whether the buyer's
//     browser stayed online long enough to see the result itself.
//   - succeeded: an escrow was captured (buyer confirmed, or it auto-released)
//     — marks it released and writes the same order/vendor_stats records the
//     hosted-checkout flow writes, so vendor-data.js reporting covers both.
//   - payment_failed / canceled: marks the escrow accordingly so it stops
//     showing as pending in the buyer's/seller's lists.
// ═══════════════════════════════════════════════════════════════

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const { AUTO_RELEASE_HOURS } = require('./escrow');

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

  // ── Legacy hosted-checkout flow (boosts, etc.) ────────────────
  if (stripeEvent.type === 'checkout.session.completed') {
    const session = stripeEvent.data.object;
    const meta    = session.metadata || {};
    const amountTotal    = session.amount_total / 100;
    const platformFee    = parseFloat(meta.platformFeeUsd || 0);
    const vendorEarnings = amountTotal - platformFee;

    await sb.from('orders').insert({
      listing_id:            meta.listingId || null,
      stripe_session_id:     session.id,
      buyer_email:           session.customer_email,
      vendor_stripe_account: meta.vendorStripeAccountId || null,
      amount_total:          amountTotal,
      platform_fee:          platformFee,
      vendor_earnings:       vendorEarnings,
      status:                'paid',
      vendor_plan:           meta.vendorPlan || 'free',
    });

    if (meta.vendorStripeAccountId) {
      await upsertVendorStats(sb, meta.vendorStripeAccountId, vendorEarnings);
    }
  }

  // ── Escrow: card authorization succeeded → funds are held ────
  if (stripeEvent.type === 'payment_intent.amount_capturable_updated') {
    const pi = stripeEvent.data.object;
    const autoReleaseAt = new Date(Date.now() + AUTO_RELEASE_HOURS * 60 * 60 * 1000).toISOString();

    const { data: escrow } = await sb.from('escrows')
      .select('id,status').eq('stripe_payment_intent', pi.id).single();

    if (escrow && escrow.status === 'pending') {
      await sb.from('escrows').update({ status: 'funded', auto_release_at: autoReleaseAt }).eq('id', escrow.id);
    }
  }

  // ── Escrow: payment captured → funds released to seller ──────
  if (stripeEvent.type === 'payment_intent.succeeded') {
    const pi = stripeEvent.data.object;
    const { data: escrow } = await sb.from('escrows')
      .select('*, listing:listings(id,title,user_id)')
      .eq('stripe_payment_intent', pi.id).single();

    if (escrow) {
      if (escrow.status === 'funded') {
        await sb.from('escrows').update({ status: 'released', released_at: new Date().toISOString() }).eq('id', escrow.id);
      }

      // Mirror the sale into orders/vendor_stats so existing reporting
      // (vendor-data.js) sees escrow-based sales too, not just hosted-checkout ones.
      const sellerId = escrow.listing ? escrow.listing.user_id : null;
      const vendorEarnings = parseFloat(escrow.amount_usd) - parseFloat(escrow.platform_fee) - parseFloat(escrow.escrow_fee);

      const { data: existingOrder } = await sb.from('orders')
        .select('id').eq('stripe_payment_intent', pi.id).single();

      if (!existingOrder) {
        await sb.from('orders').insert({
          listing_id:           escrow.listing_id,
          buyer_id:             escrow.buyer_id,
          vendor_id:            sellerId,
          stripe_payment_intent: pi.id,
          amount_total:         parseFloat(escrow.amount_usd),
          platform_fee:         parseFloat(escrow.platform_fee) + parseFloat(escrow.escrow_fee),
          vendor_earnings:      vendorEarnings,
          status:               'paid',
        });
      }

      if (sellerId) {
        await upsertVendorStatsByUser(sb, sellerId, vendorEarnings);
      }
    }
  }

  // ── Escrow: authorization failed or expired ───────────────────
  if (stripeEvent.type === 'payment_intent.payment_failed' || stripeEvent.type === 'payment_intent.canceled') {
    const pi = stripeEvent.data.object;
    const { data: escrow } = await sb.from('escrows')
      .select('id,status').eq('stripe_payment_intent', pi.id).single();

    if (escrow && ['pending', 'funded'].includes(escrow.status)) {
      await sb.from('escrows').update({
        status: stripeEvent.type === 'payment_intent.canceled' ? 'canceled' : 'failed',
      }).eq('id', escrow.id);
    } else if (!escrow) {
      // Not an escrow payment_intent — keep the legacy behavior for anything else.
      await sb.from('orders').insert({ stripe_payment_intent: pi.id, status: 'failed', amount_total: 0, platform_fee: 0, vendor_earnings: 0 }).select();
    }
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};

async function upsertVendorStats(sb, stripeAccountId, earnings) {
  const { data: existing } = await sb.from('vendor_stats').select('*').eq('stripe_account_id', stripeAccountId).single();
  if (existing) {
    await sb.from('vendor_stats').update({
      total_revenue: (existing.total_revenue || 0) + earnings,
      total_orders:  (existing.total_orders || 0) + 1,
      last_sale_at:  new Date().toISOString(),
    }).eq('stripe_account_id', stripeAccountId);
  } else {
    await sb.from('vendor_stats').insert({
      stripe_account_id: stripeAccountId, total_revenue: earnings, total_orders: 1, last_sale_at: new Date().toISOString(),
    });
  }
}

async function upsertVendorStatsByUser(sb, userId, earnings) {
  const { data: existing } = await sb.from('vendor_stats').select('*').eq('user_id', userId).single();
  if (existing) {
    await sb.from('vendor_stats').update({
      total_revenue: (existing.total_revenue || 0) + earnings,
      total_orders:  (existing.total_orders || 0) + 1,
      last_sale_at:  new Date().toISOString(),
    }).eq('user_id', userId);
  } else {
    await sb.from('vendor_stats').insert({
      user_id: userId, total_revenue: earnings, total_orders: 1, last_sale_at: new Date().toISOString(),
    });
  }
}
