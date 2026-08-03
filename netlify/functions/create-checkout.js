// ═══════════════════════════════════════════════════════════════
// SwapYard — Stripe Connect Checkout (Split Payments)
// File: netlify/functions/create-checkout.js
//
// When a buyer pays, Stripe automatically splits:
//   → Vendor receives their cut (minus SwapYard fee)
//   → SwapYard receives the platform fee
//   → All handled by Stripe, no manual transfers needed
//
// PLATFORM FEE SCHEDULE (matches your pricing plans):
//   Free tier:            5%
//   Trader Pro:           4%
//   Verified Vendor:      3%
//   Business:             2%
// ═══════════════════════════════════════════════════════════════

const Stripe = require('stripe');

// Fee rates per plan
const FEE_RATES = { free: 0.05, trader_pro: 0.04, verified_vendor: 0.03, business: 0.02 };

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 };
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

    const {
      amount,           // in dollars, e.g. 75.00
      title,            // listing title shown on Stripe checkout
      listingId,
      vendorStripeAccountId,  // vendor's connected Stripe account ID
      vendorPlan = 'free',    // vendor's subscription plan
      buyerEmail,
      shippingRate,     // optional: add shipping to total
    } = JSON.parse(event.body);

    const itemAmount  = Math.round(parseFloat(amount) * 100);       // cents
    const shipAmount  = shippingRate ? Math.round(parseFloat(shippingRate) * 100) : 0;
    const totalAmount = itemAmount + shipAmount;
    const feeRate     = FEE_RATES[vendorPlan] || FEE_RATES.free;
    const platformFee = Math.round(totalAmount * feeRate);           // SwapYard's cut in cents

    const lineItems = [
      {
        price_data: {
          currency: 'usd',
          product_data: { name: title, description: `SwapYard listing #${listingId}` },
          unit_amount: itemAmount,
        },
        quantity: 1,
      },
    ];

    // Add shipping as a separate line item if applicable
    if (shipAmount > 0) {
      lineItems.push({
        price_data: {
          currency: 'usd',
          product_data: { name: 'Shipping' },
          unit_amount: shipAmount,
        },
        quantity: 1,
      });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'link'],  // link = Stripe's 1-click checkout
      line_items: lineItems,
      mode: 'payment',
      customer_email: buyerEmail,

      // This is the magic: Stripe splits the payment automatically
      payment_intent_data: {
        application_fee_amount: platformFee,   // SwapYard keeps this
        transfer_data: {
          destination: vendorStripeAccountId,  // vendor receives the rest
        },
      },

      success_url: `${process.env.URL}?payment=success&listing=${listingId}`,
      cancel_url:  `${process.env.URL}?payment=cancelled&listing=${listingId}`,

      metadata: {
        listingId,
        vendorStripeAccountId,
        platformFeeUsd: (platformFee / 100).toFixed(2),
        vendorPlan,
      },
    });

    return {
      statusCode: 200,
      headers: h,
      body: JSON.stringify({ url: session.url, sessionId: session.id }),
    };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};
