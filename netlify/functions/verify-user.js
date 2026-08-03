// ═══════════════════════════════════════════════════════════════
// SwapYard — Basic User Verification
// File: netlify/functions/verify-user.js
//
// Implements 3 tiers of verification:
//   Tier 1 — Email verified (via Supabase auth, automatic)
//   Tier 2 — Phone number verified (via Twilio SMS)
//   Tier 3 — ID verified (via Stripe Identity — $1.50/check)
//
// SETUP:
//   Netlify env vars:
//   TWILIO_ACCOUNT_SID  → from twilio.com console
//   TWILIO_AUTH_TOKEN   → from twilio.com console
//   TWILIO_FROM_NUMBER  → your Twilio phone number
//   STRIPE_SECRET_KEY   → sk_live_...
//
//   npm install twilio stripe
// ═══════════════════════════════════════════════════════════════

const Twilio = require('twilio');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 };
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
    const { action, userId, phone, code, verifyId } = JSON.parse(event.body);
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // ── TIER 2: Send SMS verification code ──
    if (action === 'send_sms') {
      const client = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

      // Store code in Supabase with 10-min expiry
      await sb.from('verification_codes').upsert({
        user_id:    userId,
        code:       verificationCode,
        phone,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      });

      await client.messages.create({
        body: `Your SwapYard verification code is: ${verificationCode}. Valid for 10 minutes.`,
        from: process.env.TWILIO_FROM_NUMBER,
        to:   phone,
      });

      return { statusCode: 200, headers: h, body: JSON.stringify({ sent: true }) };
    }

    // ── TIER 2: Confirm SMS code ──
    if (action === 'confirm_sms') {
      const { data: record } = await sb
        .from('verification_codes')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (!record || record.code !== code || new Date(record.expires_at) < new Date()) {
        return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'Invalid or expired code' }) };
      }

      // Mark user as phone-verified
      await sb.from('profiles').upsert({ user_id: userId, phone_verified: true, phone: record.phone });
      await sb.from('verification_codes').delete().eq('user_id', userId);

      return { statusCode: 200, headers: h, body: JSON.stringify({ phoneVerified: true }) };
    }

    // ── TIER 3: Create Stripe Identity verification session ──
    if (action === 'start_id_verify') {
      const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
      const session = await stripe.identity.verificationSessions.create({
        type: 'document',
        metadata: { swapyard_user_id: userId },
        options: {
          document: {
            allowed_types: ['driving_license', 'passport', 'id_card'],
            require_id_number: true,
            require_live_capture: true,
            require_matching_selfie: true,
          },
        },
        return_url: `${process.env.URL}/vendor-dashboard.html?id_verify=complete`,
      });

      // Store session ID to check later
      await sb.from('profiles').upsert({ user_id: userId, stripe_verify_session: session.id });

      return {
        statusCode: 200,
        headers: h,
        body: JSON.stringify({ verifyUrl: session.url, sessionId: session.id }),
      };
    }

    // ── TIER 3: Check ID verification result ──
    if (action === 'check_id_verify') {
      const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
      const session = await stripe.identity.verificationSessions.retrieve(verifyId);

      if (session.status === 'verified') {
        await sb.from('profiles').upsert({ user_id: userId, id_verified: true });
        return { statusCode: 200, headers: h, body: JSON.stringify({ idVerified: true }) };
      }

      return { statusCode: 200, headers: h, body: JSON.stringify({ idVerified: false, status: session.status }) };
    }

    return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (e) {
    console.error(e);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};
