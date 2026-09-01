// ═══════════════════════════════════════════════════════════════
// The Swap Yard — Escrow / Buyer Protection for Local Trades
// File: netlify/functions/escrow.js
//
// HOW IT WORKS:
//   1. Buyer authorizes a card payment (payment_intent, capture_method=manual —
//      the card is verified and the funds are set aside, but not yet captured).
//   2. Stripe confirms the authorization via webhook → escrow flips to "funded".
//   3. Seller arranges the meetup/handoff.
//   4. After the meetup, buyer confirms receipt → funds are captured and
//      transferred to the seller's connected Stripe account (minus fees).
//   5. If the buyer disputes, a 72-hour review window opens.
//   6. If the buyer never confirms, funds auto-release after AUTO_RELEASE_HOURS.
//
// WHY 24 HOURS, NOT 7 DAYS:
//   Stripe automatically cancels an uncaptured card authorization after
//   ~7 days no matter what — that's a hard ceiling this code cannot extend
//   past. The original 7-day auto-release was set right at that ceiling,
//   which meant sellers could wait a full week to get paid for an item
//   they'd already handed over. Since these are local, in-person meetups
//   (not shipped goods), there's no reason to wait anywhere near that long —
//   AUTO_RELEASE_HOURS defaults to 24 and can be safely set anywhere up to
//   a few days without any risk of hitting Stripe's expiration window.
//
// SECURITY NOTE (fixed from the original version of this file):
//   create_escrow no longer trusts a client-supplied vendorStripeAccountId
//   or vendorPlan. A buyer's browser could previously be tampered with to
//   redirect a payment to an arbitrary Stripe account. This version looks
//   up the seller's real connected account and plan server-side from the
//   listing and profiles table, so the destination can't be spoofed.
//
// ESCROW FEE: 1% of transaction (on top of the plan's platform fee)
// ═══════════════════════════════════════════════════════════════

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const ESCROW_FEE_RATE     = 0.01; // 1% escrow service fee
const AUTO_RELEASE_HOURS  = 24;   // Auto-release if the buyer never confirms
// Three tiers (Free / Plus / Business) per the Pricing & Tiers proposal,
// Option 2 — consolidated from the original four (Free / Trader Pro /
// Verified Vendor / Business). Any profile still holding one of the old
// tier names is normalized below rather than silently falling through
// to the Free rate.
const PLAN_FEES = { free: 0.07, plus: 0.04, business: 0.025 };
function normalizePlanKey(raw) {
  if (raw === 'plus' || raw === 'trader_pro') return 'plus';
  if (raw === 'business' || raw === 'verified_vendor') return 'business';
  return 'free';
}

exports.handler = async (event) => {
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  // Netlify's scheduled-function invocations don't send a POST body — they
  // just call the handler on a cron. Treat a bodyless invocation as the
  // auto-release sweep rather than failing on JSON.parse(undefined).
  let action, params;
  if (!event.body) {
    action = 'auto_release_check';
    params = {};
  } else {
    if (event.httpMethod && event.httpMethod !== 'POST') return { statusCode: 405 };
    try {
      ({ action, ...params } = JSON.parse(event.body));
    } catch (e) {
      return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const sb     = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    // ── CREATE ESCROW (buyer authorizes, funds are held) ──────
    if (action === 'create_escrow') {
      const { listingId, buyerId, buyerEmail } = params;
      if (!listingId || !buyerId) {
        return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'listingId and buyerId are required' }) };
      }

      const { data: listing } = await sb.from('listings')
        .select('id,title,price_usd,user_id,is_active').eq('id', listingId).single();
      if (!listing || !listing.is_active) {
        return { statusCode: 404, headers: h, body: JSON.stringify({ error: 'Listing not found or no longer active' }) };
      }
      if (!listing.price_usd || listing.price_usd <= 0) {
        return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'This listing has no price set — arrange payment directly with the seller' }) };
      }
      if (listing.user_id === buyerId) {
        return { statusCode: 400, headers: h, body: JSON.stringify({ error: "You can't buy your own listing" }) };
      }

      const { data: seller } = await sb.from('profiles')
        .select('stripe_account_id,plan').eq('id', listing.user_id).single();
      if (!seller || !seller.stripe_account_id) {
        return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'seller_not_connected', message: "This seller hasn't set up card payouts yet — message them to arrange another payment method." }) };
      }

      const amount       = parseFloat(listing.price_usd);
      const vendorPlan   = normalizePlanKey(seller.plan);
      const platformFee  = Math.round(amount * 100 * PLAN_FEES[vendorPlan]);
      const escrowFee    = Math.round(amount * 100 * ESCROW_FEE_RATE);
      const totalFees    = platformFee + escrowFee;

      // Manual capture: this authorizes and holds the card, it does not
      // charge it yet. Funds move only when confirm_receipt or the
      // auto-release sweep later calls stripe.paymentIntents.capture().
      const paymentIntent = await stripe.paymentIntents.create({
        amount:                Math.round(amount * 100),
        currency:              'usd',
        capture_method:        'manual',
        payment_method_types:  ['card'],
        receipt_email:         buyerEmail,
        description:           `The Swap Yard — ${listing.title} (listing ${listingId})`,
        application_fee_amount: totalFees,
        transfer_data:         { destination: seller.stripe_account_id },
        metadata: {
          listingId, buyerId, sellerId: listing.user_id, vendorPlan,
          platformFee: (platformFee / 100).toFixed(2),
          escrowFee:   (escrowFee / 100).toFixed(2),
        },
      });

      // Status starts as 'pending' — it is NOT funded yet. The
      // payment_intent.amount_capturable_updated webhook flips it to
      // 'funded' once Stripe confirms the card was actually authorized.
      const { data: escrow, error: insErr } = await sb.from('escrows').insert({
        listing_id:            listingId,
        buyer_id:              buyerId,
        stripe_payment_intent: paymentIntent.id,
        amount_usd:            amount,
        platform_fee:          platformFee / 100,
        escrow_fee:            escrowFee / 100,
        status:                'pending',
      }).select().single();

      if (insErr) {
        console.error('Failed to record escrow:', insErr);
        return { statusCode: 500, headers: h, body: JSON.stringify({ error: 'Could not start the transaction — try again.' }) };
      }

      return {
        statusCode: 200, headers: h,
        body: JSON.stringify({
          escrowId:     escrow.id,
          clientSecret: paymentIntent.client_secret,
          amount, platformFee: platformFee / 100, escrowFee: escrowFee / 100,
          total: amount + (totalFees / 100),
        }),
      };
    }

    // ── CONFIRM RECEIPT (buyer releases funds to seller) ──────
    if (action === 'confirm_receipt') {
      const { escrowId, buyerId } = params;
      const { data: escrow } = await sb.from('escrows').select('*').eq('id', escrowId).single();
      if (!escrow) return { statusCode: 404, headers: h, body: JSON.stringify({ error: 'Escrow not found' }) };
      if (escrow.buyer_id !== buyerId) return { statusCode: 403, headers: h, body: JSON.stringify({ error: 'Not authorized' }) };
      if (escrow.status !== 'funded') return { statusCode: 400, headers: h, body: JSON.stringify({ error: `This escrow is "${escrow.status}", not ready to release` }) };

      await stripe.paymentIntents.capture(escrow.stripe_payment_intent);
      // Optimistic local update — the payment_intent.succeeded webhook is
      // the authoritative confirmation and will also write the order record.
      await sb.from('escrows').update({ status: 'released', released_at: new Date().toISOString() }).eq('id', escrowId);

      return { statusCode: 200, headers: h, body: JSON.stringify({ success: true, message: 'Funds released to the seller.' }) };
    }

    // ── OPEN DISPUTE (buyer disputes before release) ──────────
    if (action === 'open_dispute') {
      const { escrowId, buyerId, reason } = params;
      const { data: escrow } = await sb.from('escrows').select('*').eq('id', escrowId).single();
      if (!escrow) return { statusCode: 404, headers: h, body: JSON.stringify({ error: 'Escrow not found' }) };
      if (escrow.buyer_id !== buyerId) return { statusCode: 403, headers: h, body: JSON.stringify({ error: 'Not authorized' }) };
      if (escrow.status !== 'funded') return { statusCode: 400, headers: h, body: JSON.stringify({ error: `Can't dispute — escrow is "${escrow.status}"` }) };

      const reviewDeadline = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
      await sb.from('escrows').update({
        status:             'disputed',
        dispute_reason:     reason || null,
        dispute_opened_at:  new Date().toISOString(),
        review_deadline:    reviewDeadline,
      }).eq('id', escrowId);

      if (process.env.URL) {
        fetch(`${process.env.URL}/.netlify/functions/send-email`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: process.env.ADMIN_EMAIL || 'disputes@theswapyard.com', type: 'custom',
            subject: `⚠️ Escrow dispute opened — ${escrowId}`,
            data: { body: `Reason: ${reason || '(none given)'}. Review by ${reviewDeadline}.` },
          }),
        }).catch(function(){});
      }

      return { statusCode: 200, headers: h, body: JSON.stringify({ success: true, reviewDeadline, message: "Dispute opened. We'll review within 72 hours." }) };
    }

    // ── AUTO-RELEASE SWEEP (scheduled — hourly) ───────────────
    if (action === 'auto_release_check') {
      const { data: overdue } = await sb.from('escrows')
        .select('*').eq('status', 'funded').lt('auto_release_at', new Date().toISOString());

      let released = 0;
      for (const escrow of overdue || []) {
        try {
          await stripe.paymentIntents.capture(escrow.stripe_payment_intent);
          await sb.from('escrows').update({ status: 'auto_released', released_at: new Date().toISOString() }).eq('id', escrow.id);
          released++;
        } catch (e) { console.error(`Failed auto-release for escrow ${escrow.id}:`, e.message); }
      }
      return { statusCode: 200, headers: h, body: JSON.stringify({ autoReleased: released, checked: (overdue || []).length }) };
    }

    // ── GET ONE ESCROW ─────────────────────────────────────────
    if (action === 'get_status') {
      const { escrowId } = params;
      const { data: escrow } = await sb.from('escrows').select('*').eq('id', escrowId).single();
      if (!escrow) return { statusCode: 404, headers: h, body: JSON.stringify({ error: 'Not found' }) };
      return { statusCode: 200, headers: h, body: JSON.stringify(escrow) };
    }

    // ── MY PURCHASES (buyer-side pending/active escrows) ──────
    if (action === 'get_my_purchases') {
      const { buyerId } = params;
      const { data } = await sb.from('escrows')
        .select('*, listing:listings(title,emoji,price_usd)')
        .eq('buyer_id', buyerId).in('status', ['pending', 'funded', 'disputed'])
        .order('created_at', { ascending: false });
      return { statusCode: 200, headers: h, body: JSON.stringify({ purchases: data || [] }) };
    }

    // ── MY SALES (seller-side pending/active escrows) ─────────
    if (action === 'get_my_sales') {
      const { sellerId } = params;
      const { data } = await sb.from('escrows')
        .select('*, listing:listings!inner(title,emoji,price_usd,user_id)')
        .eq('listing.user_id', sellerId).in('status', ['pending', 'funded', 'disputed'])
        .order('created_at', { ascending: false });
      return { statusCode: 200, headers: h, body: JSON.stringify({ sales: data || [] }) };
    }

    return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};

// Exported for the webhook to reuse the exact same window when it flips an
// escrow to 'funded' — keeping the "how long" logic in one place.
exports.AUTO_RELEASE_HOURS = AUTO_RELEASE_HOURS;
