// ═══════════════════════════════════════════════════════════════
// The Swap Yard — AML/BSA Compliance Monitor
// File: netlify/functions/aml-compliance.js
//
// LEGAL BACKGROUND:
//   The Bank Secrecy Act (BSA) and Anti-Money Laundering (AML)
//   regulations require marketplaces that process payments to:
//   1. Monitor for suspicious transaction patterns
//   2. File Suspicious Activity Reports (SARs) with FinCEN when warranted
//   3. Maintain records of transactions over $3,000
//   4. Implement a Customer Identification Program (CIP)
//   5. Not process transactions for sanctioned individuals (OFAC)
//
// NOTE: Stripe handles most BSA/AML compliance for card payments
//   automatically via their KYC process on Connect accounts.
//   This function adds the marketplace-level layer on top.
//
// DISCLAIMER: This is a compliance framework starter.
//   Consult a BSA Officer or compliance attorney before going live
//   with high transaction volumes. The Swap Yard should designate
//   a BSA Compliance Officer once monthly volume exceeds $10,000.
// ═══════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

// SAR thresholds (align with BSA requirements)
const SAR_THRESHOLDS = {
  SINGLE_TRANSACTION:    5000,   // Flag single transactions over $5,000
  DAILY_VOLUME:         10000,   // Flag users with >$10k in a single day
  MONTHLY_VOLUME:       50000,   // Flag users with >$50k/month
  STRUCTURING_WINDOW:    3000,   // Watch for transactions just under $3k (structuring)
  VELOCITY_COUNT:           20,  // Flag 20+ transactions in 24 hours
};

// OFAC SDN list check — in production integrate with OFAC API or Dow Jones
// For now we maintain a basic blocklist
const BLOCKED_PATTERNS = [
  /\b(drug|narco|weapon|terror|launder)\b/i,
];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 };
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
    const { action, ...params } = JSON.parse(event.body);
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // ── SCREEN NEW USER (CIP — Customer Identification Program) ──
    if (action === 'screen_user') {
      const { userId, name, email, zip } = params;
      const flags = [];

      // Check name against blocked patterns
      if (BLOCKED_PATTERNS.some(p => p.test(name))) {
        flags.push({ type: 'NAME_PATTERN', severity: 'HIGH', detail: 'Name matches suspicious pattern' });
      }

      // Log the CIP check
      await sb.from('aml_checks').insert({
        user_id:    userId,
        check_type: 'CIP',
        flags:      JSON.stringify(flags),
        passed:     flags.filter(f => f.severity === 'HIGH').length === 0,
        checked_at: new Date().toISOString(),
      });

      const blocked = flags.some(f => f.severity === 'HIGH');
      if (blocked) {
        await sb.from('profiles').update({ is_active: false, blocked_reason: 'AML_CIP_FAIL' }).eq('id', userId);
      }

      return { statusCode: 200, headers: h, body: JSON.stringify({ passed: !blocked, flags }) };
    }

    // ── MONITOR TRANSACTION ──
    if (action === 'monitor_transaction') {
      const { userId, amount, listingId, transactionType = 'sale' } = params;
      const flags = [];
      const now   = new Date();
      const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
      const since30d = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

      // Flag large single transactions
      if (amount >= SAR_THRESHOLDS.SINGLE_TRANSACTION) {
        flags.push({ type: 'LARGE_TRANSACTION', severity: 'MEDIUM', amount, detail: `Transaction of $${amount} exceeds $${SAR_THRESHOLDS.SINGLE_TRANSACTION} threshold` });
      }

      // Check for structuring (multiple transactions just under $3k)
      const { data: recentTxns } = await sb.from('orders')
        .select('amount_total').eq('vendor_user_id', userId)
        .gte('created_at', since24h)
        .lt('amount_total', SAR_THRESHOLDS.STRUCTURING_WINDOW);

      if (recentTxns?.length >= 3) {
        flags.push({ type: 'STRUCTURING', severity: 'HIGH', detail: `${recentTxns.length} transactions just under $${SAR_THRESHOLDS.STRUCTURING_WINDOW} in 24 hours` });
      }

      // Check daily velocity
      const { data: dailyTxns } = await sb.from('orders').select('id').eq('vendor_user_id', userId).gte('created_at', since24h);
      if ((dailyTxns?.length || 0) >= SAR_THRESHOLDS.VELOCITY_COUNT) {
        flags.push({ type: 'HIGH_VELOCITY', severity: 'MEDIUM', detail: `${dailyTxns.length} transactions in 24 hours` });
      }

      // Check monthly volume
      const { data: monthlyTxns } = await sb.from('orders').select('amount_total').eq('vendor_user_id', userId).gte('created_at', since30d);
      const monthlyVolume = monthlyTxns?.reduce((s, t) => s + (t.amount_total || 0), 0) || 0;
      if (monthlyVolume + amount >= SAR_THRESHOLDS.MONTHLY_VOLUME) {
        flags.push({ type: 'HIGH_MONTHLY_VOLUME', severity: 'MEDIUM', detail: `Monthly volume of $${(monthlyVolume + amount).toFixed(2)} exceeds threshold` });
      }

      // Log the check
      await sb.from('aml_checks').insert({
        user_id:        userId,
        listing_id:     listingId,
        check_type:     'TRANSACTION',
        amount,
        flags:          JSON.stringify(flags),
        passed:         flags.filter(f => f.severity === 'HIGH').length === 0,
        checked_at:     new Date().toISOString(),
      });

      // If HIGH severity flags, alert compliance team
      const highFlags = flags.filter(f => f.severity === 'HIGH');
      if (highFlags.length > 0 && process.env.ADMIN_EMAIL) {
        await fetch(`${process.env.URL}/.netlify/functions/send-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to:      process.env.ADMIN_EMAIL,
            type:    'custom',
            subject: `🚨 AML ALERT — High severity flag for user ${userId}`,
            data: { body: highFlags.map(f => `${f.type}: ${f.detail}`).join('\n') },
          }),
        });
      }

      return {
        statusCode: 200, headers: h,
        body: JSON.stringify({
          approved: highFlags.length === 0,
          flags,
          requiresReview: flags.length > 0,
        }),
      };
    }

    // ── GENERATE COMPLIANCE REPORT ──
    if (action === 'compliance_report') {
      const { year, month } = params;
      const startDate = `${year}-${String(month).padStart(2,'0')}-01T00:00:00Z`;
      const endDate   = new Date(year, month, 0).toISOString();

      const { data: checks } = await sb.from('aml_checks')
        .select('*').gte('checked_at', startDate).lte('checked_at', endDate);

      const { data: largeOrders } = await sb.from('orders')
        .select('id, amount_total, vendor_user_id, created_at')
        .gte('amount_total', 3000)
        .gte('created_at', startDate).lte('created_at', endDate);

      const summary = {
        period:           `${year}-${month}`,
        totalChecks:      checks?.length || 0,
        flaggedChecks:    checks?.filter(c => !c.passed).length || 0,
        highSeverityFlags:checks?.filter(c => { try { return JSON.parse(c.flags||'[]').some(f=>f.severity==='HIGH'); } catch{ return false; } }).length || 0,
        largeTransactions:largeOrders?.length || 0,
        largeTransactionVolume: largeOrders?.reduce((s,o) => s+(o.amount_total||0), 0).toFixed(2),
        sarRequired:      false, // Set to true manually if SAR filing needed
      };

      return { statusCode: 200, headers: h, body: JSON.stringify({ summary, checks: checks?.slice(0, 50), largeOrders }) };
    }

    return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};
