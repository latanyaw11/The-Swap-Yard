// ═══════════════════════════════════════════════════════════════
// The Swap Yard — AI Vendor Support Agent
// File: netlify/functions/support-agent.js
//
// SETUP:
//   Add to Netlify environment variables:
//   ANTHROPIC_API_KEY  → sk-ant-... (from console.anthropic.com)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (already set)
//
// HOW IT WORKS:
//   1. Vendor asks a question in the support widget
//   2. Function pulls relevant context (their orders, plan, listings)
//   3. Sends to Claude with full Swap Yard knowledge base
//   4. Returns a helpful, specific answer
//   5. Escalates to human if confidence is low
// ═══════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

// ── SWAP YARD KNOWLEDGE BASE ──────────────────────────────────
// This is what the agent knows about your platform.
// Update this as your platform evolves.
const SYSTEM_PROMPT = `You are a helpful vendor support agent for The Swap Yard, a nationwide buy/sell/trade marketplace rooted in Research Triangle Park, NC. You are friendly, concise, and knowledgeable about the platform.

## YOUR ROLE
You help vendors (sellers and traders) on The Swap Yard with questions about:
- Listing items, services, and events
- Setting Fair Market Value (FMV) for barter items
- Shipping labels and EasyPost rates
- Stripe Connect setup and vendor payouts
- Tax setup via Stripe (W-9 handled by Stripe — The Swap Yard never stores SSNs)
- Barter reports and 1099-B tax forms
- Platform fees by plan
- Verification (email, phone via Twilio, ID via Stripe Identity)
- Specialist certifications
- Escrow and buyer protection
- Premium listing boosts and referral program
- Prohibited items and platform rules
- Account settings

## PLATFORM FACTS

### Fees by Plan
- Free: 5% transaction fee, up to 5 listings
- Trader Pro: $9.99/month, 4% fee, unlimited listings
- Verified Vendor: $29.99/month, 3% fee, verified badge, priority placement
- Business: $79.99/month, 2% fee, bulk CSV upload, API access

### Shipping
- Live rates from USPS, UPS, FedEx via EasyPost
- Default ship-from ZIP: 27709 (RTP area)
- Labels purchased and printed directly from the vendor dashboard
- Tracking automatically attached to orders

### Barter & Tax
- All barter income is taxable — FMV of what you receive = income (IRS rules)
- The Swap Yard issues 1099-B forms for qualifying barter activity
- Annual trade report available every January from the dashboard
- Tax setup (W-9) is handled entirely by Stripe — we never store SSNs
- Trade tiers: Under $600 (simple), $600-$5,000 (standard), Over $5,000 (complex)

### Payments
- Card payments via Stripe (buyer protection applies)
- Cash, stablecoins, and tokens (peer-to-peer, no platform protection)
- Barter/trade (use escrow for high-value trades)
- Escrow: Stripe holds funds until buyer confirms receipt, 1% fee, 7-day auto-release

### Listing Boosts
- Basic: $2.99 / 3 days top placement
- Featured: $5.99 / 7 days + homepage spotlight
- Premium Plus: $9.99 / 14 days

### Verification Tiers
- Tier 1: Email (automatic)
- Tier 2: Phone via SMS (Twilio)
- Tier 3: Government ID (Stripe Identity)

### Prohibited Items
- Drugs, weapons, trafficking, counterfeit goods, hazardous materials
- Full list at /terms.html

### Contact & Escalation
- For issues you cannot resolve, direct vendors to: support@theswapyard.com
- For disputes: disputes@theswapyard.com
- For legal questions: legal@theswapyard.com

## RESPONSE STYLE
- Be warm, clear, and brief — 2-4 sentences for simple questions
- Use bullet points for multi-step instructions
- Always mention where in the dashboard to find things (e.g. "Go to Dashboard → Shipping")
- If you don't know something specific to their account, say so and offer to escalate
- Never make up fees, policies, or features that aren't listed above
- If asked about something outside your knowledge, say: "I want to make sure I give you accurate info on that — let me connect you with our support team."

## ESCALATION TRIGGERS
Escalate (recommend emailing support) if the vendor asks about:
- A specific order that seems wrong
- A payment that hasn't arrived
- Account suspension or banning
- Legal disputes
- Anything requiring account-level investigation`;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
    };
  }

  if (event.httpMethod !== 'POST') return { statusCode: 405 };

  const h = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  try {
    const { message, conversationHistory = [], userId } = JSON.parse(event.body);

    if (!message) {
      return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'Message is required' }) };
    }

    // ── Pull vendor context from Supabase ──
    let vendorContext = '';
    if (userId && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

        const [profileRes, statsRes, ordersRes] = await Promise.all([
          sb.from('profiles').select('display_name, vendor_plan, email_verified, phone_verified, id_verified, city, state, stripe_account_id, w9_on_file').eq('id', userId).single(),
          sb.from('vendor_stats').select('total_revenue, total_orders, total_barters, avg_rating').eq('user_id', userId).single(),
          sb.from('orders').select('status, amount_total, created_at').eq('vendor_user_id', userId).order('created_at', { ascending: false }).limit(5),
        ]);

        const p = profileRes.data;
        const s = statsRes.data;

        if (p) {
          vendorContext = `
## THIS VENDOR'S ACCOUNT CONTEXT
- Name: ${p.display_name || 'Not set'}
- Plan: ${p.vendor_plan || 'free'}
- Location: ${p.city || 'Unknown'}, ${p.state || 'NC'}
- Email verified: ${p.email_verified ? 'Yes' : 'No'}
- Phone verified: ${p.phone_verified ? 'Yes' : 'No'}
- ID verified: ${p.id_verified ? 'Yes' : 'No'}
- Stripe Connect: ${p.stripe_account_id ? 'Connected' : 'Not connected'}
- Tax setup (W-9 via Stripe): ${p.w9_on_file ? 'Complete' : 'Not completed'}
${s ? `- Total revenue: $${s.total_revenue || 0}
- Total orders: ${s.total_orders || 0}
- Barter trades: ${s.total_barters || 0}
- Avg rating: ${s.avg_rating || 'No ratings yet'}` : ''}
${ordersRes.data?.length ? `- Recent orders: ${ordersRes.data.map(o => `${o.status} ($${o.amount_total})`).join(', ')}` : ''}

Use this context to give personalized answers. For example if they ask why they can't receive payouts, you can see their Stripe Connect status.`;
        }
      } catch (e) {
        // Context fetch failed — continue without it
        console.error('Context fetch error:', e.message);
      }
    }

    // ── Build conversation for Claude ──
    const messages = [
      // Include recent conversation history (last 10 exchanges)
      ...conversationHistory.slice(-10),
      { role: 'user', content: message },
    ];

    // ── Call Claude API ──
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system:     SYSTEM_PROMPT + (vendorContext ? '\n\n' + vendorContext : ''),
        messages,
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || 'Claude API error');
    }

    const data = await response.json();
    const reply = data.content[0]?.text || 'Sorry, I had trouble generating a response. Please try again.';

    // ── Detect escalation triggers ──
    const escalationKeywords = ['suspend', 'banned', 'payment missing', 'charged wrong', 'fraud', 'legal', 'dispute', 'refund'];
    const shouldEscalate = escalationKeywords.some(kw =>
      message.toLowerCase().includes(kw) || reply.toLowerCase().includes('support team')
    );

    // ── Log conversation to Supabase (optional) ──
    if (userId && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      try {
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
        await sb.from('support_conversations').insert({
          user_id:   userId,
          question:  message.slice(0, 500),
          answer:    reply.slice(0, 1000),
          escalated: shouldEscalate,
          created_at: new Date().toISOString(),
        });
      } catch (e) { /* non-blocking */ }
    }

    return {
      statusCode: 200,
      headers: h,
      body: JSON.stringify({
        reply,
        shouldEscalate,
        escalationEmail: shouldEscalate ? 'support@theswapyard.com' : null,
      }),
    };
  } catch (e) {
    console.error('Support agent error:', e);
    return {
      statusCode: 500,
      headers: h,
      body: JSON.stringify({
        reply: "I'm having trouble connecting right now. Please email us at support@theswapyard.com and we'll get back to you shortly.",
        shouldEscalate: true,
        escalationEmail: 'support@theswapyard.com',
      }),
    };
  }
};
