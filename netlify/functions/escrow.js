// ═══════════════════════════════════════════════════════════════
// The Swap Yard — Escrow / Buyer Protection for Local Trades
// File: netlify/functions/escrow.js
//
// HOW IT WORKS:
//   1. Buyer pays into Stripe-held escrow (payment_intent with capture_method=manual)
//   2. Seller sees "Escrow Funded" — arranges meetup
//   3. After meetup, buyer confirms receipt → funds released to seller
//   4. If buyer disputes, 72-hour review window opens
//   5. If no confirmation after 7 days → auto-release to seller
//   6. The Swap Yard earns the platform fee on top
//
// ESCROW FEE: 1% of transaction (on top of plan fee)
// MAX ESCROW HOLD: 7 days
// ═══════════════════════════════════════════════════════════════

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const ESCROW_FEE_RATE  = 0.01;  // 1% escrow service fee
const AUTO_RELEASE_DAYS = 7;    // Auto-release after 7 days if buyer doesn't respond

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 };
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
    const { action, ...params } = JSON.parse(event.body);
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const sb     = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // ── CREATE ESCROW (buyer pays, funds held) ──
    if (action === 'create_escrow') {
      const { listingId, buyerId, buyerEmail, vendorStripeAccountId, amount, vendorPlan = 'free' } = params;

      const PLAN_FEES = { free: 0.05, trader_pro: 0.04, verified_vendor: 0.03, business: 0.02 };
      const platformFee  = Math.round(amount * 100 * (PLAN_FEES[vendorPlan] || 0.05));
      const escrowFee    = Math.round(amount * 100 * ESCROW_FEE_RATE);
      const totalFees    = platformFee + escrowFee;
      const autoReleaseAt = new Date(Date.now() + AUTO_RELEASE_DAYS * 24 * 60 * 60 * 1000).toISOString();

      // Create payment intent with manual capture = funds held but not captured
      const paymentIntent = await stripe.paymentIntents.create({
        amount:           Math.round(amount * 100),
        currency:         'usd',
        capture_method:   'manual',       // ← KEY: holds funds without releasing
        payment_method_types: ['card'],
        receipt_email:    buyerEmail,
        description:      `Escrow — The Swap Yard listing ${listingId}`,
        application_fee_amount: totalFees,
        transfer_data:    { destination: vendorStripeAccountId },
        metadata: {
          listingId, buyerId, vendorStripeAccountId, vendorPlan,
          platformFee: (platformFee / 100).toFixed(2),
          escrowFee:   (escrowFee   / 100).toFixed(2),
          autoReleaseAt,
        },
      });

      // Save escrow record to Supabase
      const { data: escrow } = await sb.from('escrows').insert({
        listing_id:             listingId,
        buyer_id:               buyerId,
        stripe_payment_intent:  paymentIntent.id,
        amount_usd:             amount,
        platform_fee:           platformFee / 100,
        escrow_fee:             escrowFee   / 100,
        status:                 'funded',
        auto_release_at:        autoReleaseAt,
        created_at:             new Date().toISOString(),
      }).select().single();

      return {
        statusCode: 200, headers: h,
        body: JSON.stringify({
          escrowId:        escrow?.id,
          clientSecret:    paymentIntent.client_secret,
          paymentIntentId: paymentIntent.id,
          autoReleaseAt,
          message:         'Funds held in escrow. Complete your meetup then confirm receipt.',
        }),
      };
    }

    // ── CONFIRM RECEIPT (buyer releases funds to seller) ──
    if (action === 'confirm_receipt') {
      const { escrowId, buyerId } = params;

      const { data: escrow } = await sb.from('escrows').select('*').eq('id', escrowId).single();
      if (!escrow) return { statusCode: 404, headers: h, body: JSON.stringify({ error: 'Escrow not found' }) };
      if (escrow.buyer_id !== buyerId) return { statusCode: 403, headers: h, body: JSON.stringify({ error: 'Not authorized' }) };
      if (escrow.status !== 'funded') return { statusCode: 400, headers: h, body: JSON.stringify({ error: `Escrow is ${escrow.status}` }) };

      // Capture the payment — releases funds to seller (minus fees)
      await stripe.paymentIntents.capture(escrow.stripe_payment_intent);

      await sb.from('escrows').update({ status: 'released', released_at: new Date().toISOString() }).eq('id', escrowId);

      return { statusCode: 200, headers: h, body: JSON.stringify({ success: true, message: 'Funds released to seller.' }) };
    }

    // ── OPEN DISPUTE (buyer disputes before release) ──
    if (action === 'open_dispute') {
      const { escrowId, buyerId, reason } = params;

      const { data: escrow } = await sb.from('escrows').select('*').eq('id', escrowId).single();
      if (!escrow) return { statusCode: 404, headers: h, body: JSON.stringify({ error: 'Escrow not found' }) };
      if (escrow.buyer_id !== buyerId) return { statusCode: 403, headers: h, body: JSON.stringify({ error: 'Not authorized' }) };
      if (escrow.status !== 'funded') return { statusCode: 400, headers: h, body: JSON.stringify({ error: `Cannot dispute — escrow is ${escrow.status}` }) };

      const reviewDeadline = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

      await sb.from('escrows').update({
        status:          'disputed',
        dispute_reason:  reason,
        dispute_opened_at: new Date().toISOString(),
        review_deadline:   reviewDeadline,
      }).eq('id', escrowId);

      // Notify The Swap Yard team
      await fetch('/.netlify/functions/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to:   process.env.ADMIN_EMAIL || 'disputes@theswapyard.com',
          type: 'custom',
          subject: `⚠️ Escrow Dispute Opened — ${escrowId}`,
          data: { body: `Dispute reason: ${reason}. Review by ${reviewDeadline}.` },
        }),
      });

      return { statusCode: 200, headers: h, body: JSON.stringify({ success: true, reviewDeadline, message: 'Dispute opened. The Swap Yard will review within 72 hours.' }) };
    }

    // ── AUTO-RELEASE CHECK (called by scheduled function) ──
    if (action === 'auto_release_check') {
      const { data: overdue } = await sb.from('escrows')
        .select('*').eq('status', 'funded')
        .lt('auto_release_at', new Date().toISOString());

      let released = 0;
      for (const escrow of overdue || []) {
        try {
          await stripe.paymentIntents.capture(escrow.stripe_payment_intent);
          await sb.from('escrows').update({ status: 'auto_released', released_at: new Date().toISOString() }).eq('id', escrow.id);
          released++;
        } catch (e) { console.error(`Failed auto-release for escrow ${escrow.id}:`, e); }
      }

      return { statusCode: 200, headers: h, body: JSON.stringify({ autoReleased: released }) };
    }

    // ── GET ESCROW STATUS ──
    if (action === 'get_status') {
      const { escrowId } = params;
      const { data: escrow } = await sb.from('escrows').select('*').eq('id', escrowId).single();
      if (!escrow) return { statusCode: 404, headers: h, body: JSON.stringify({ error: 'Not found' }) };
      return { statusCode: 200, headers: h, body: JSON.stringify(escrow) };
    }

    return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};
