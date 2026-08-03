// ═══════════════════════════════════════════════════════════════
// SwapYard — Barter Transaction Reporter
// File: netlify/functions/barter-report.js
//
// IRS BACKGROUND:
//   Under IRC §1041 and Treasury Regulation §1.6045-1, barter
//   exchanges with more than 100 transactions OR $1 of barter
//   income in a calendar year must file Form 1099-B for each
//   member. SwapYard's reporting strategy:
//
//   1. Record FMV of both sides of every barter at time of trade
//   2. Generate annual 1099-B report per user (download as CSV)
//   3. Remind users: FMV received = taxable income
//   4. This endpoint returns a user's barter summary for the year
//
// SUPABASE TABLE NEEDED (run in SQL Editor):
/*
  CREATE TABLE barter_transactions (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    created_at timestamptz DEFAULT now(),
    user_a_id uuid,           -- who offered
    user_b_id uuid,           -- who received
    listing_id_a uuid,        -- what user_a gave
    listing_id_b uuid,        -- what user_b gave
    fmv_a numeric,            -- fair market value of user_a's item
    fmv_b numeric,            -- fair market value of user_b's item
    agreed_at timestamptz,
    status text DEFAULT 'pending',  -- pending | completed | disputed
    notes text
  );
*/
// ═══════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405 };
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
    const sb     = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const userId = event.queryStringParameters?.userId;
    const year   = event.queryStringParameters?.year || new Date().getFullYear();

    if (!userId) return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'userId required' }) };

    const startDate = `${year}-01-01T00:00:00Z`;
    const endDate   = `${year}-12-31T23:59:59Z`;

    // Get all completed barters involving this user
    const { data: barters } = await sb
      .from('barter_transactions')
      .select('*, listings!listing_id_a(title), listings!listing_id_b(title)')
      .or(`user_a_id.eq.${userId},user_b_id.eq.${userId}`)
      .eq('status', 'completed')
      .gte('agreed_at', startDate)
      .lte('agreed_at', endDate);

    // Calculate total FMV received (what this user got = their taxable income)
    let totalFmvReceived = 0;
    const reportLines = (barters || []).map(b => {
      const isUserA = b.user_a_id === userId;
      // What the user RECEIVED (the other person's item's FMV)
      const fmvReceived = isUserA ? b.fmv_b : b.fmv_a;
      // What the user GAVE (their item's FMV = their cost basis)
      const fmvGiven    = isUserA ? b.fmv_a : b.fmv_b;
      totalFmvReceived += fmvReceived || 0;

      return {
        date:         b.agreed_at?.split('T')[0],
        received:     isUserA ? b.listing_id_b : b.listing_id_a,
        fmvReceived:  fmvReceived?.toFixed(2),
        gave:         isUserA ? b.listing_id_a : b.listing_id_b,
        fmvGiven:     fmvGiven?.toFixed(2),
        gainLoss:     ((fmvReceived || 0) - (fmvGiven || 0)).toFixed(2),
      };
    });

    // 1099-B filing threshold check
    const requiresReporting = barters?.length >= 1; // IRS: any barter income is reportable

    return {
      statusCode: 200,
      headers: h,
      body: JSON.stringify({
        userId,
        year,
        totalTransactions:  barters?.length || 0,
        totalFmvReceived:   totalFmvReceived.toFixed(2),
        requiresReporting,
        irsNote:            requiresReporting
          ? `You received $${totalFmvReceived.toFixed(2)} in barter income in ${year}. This is taxable. SwapYard may issue a 1099-B. Consult a tax professional.`
          : `No completed barter transactions in ${year}.`,
        transactions: reportLines,
        // CSV export format
        csvRows: [
          'Date,Item Received,FMV Received,Item Given,FMV Given,Gain/Loss',
          ...reportLines.map(r => `${r.date},"${r.received}",${r.fmvReceived},"${r.gave}",${r.fmvGiven},${r.gainLoss}`)
        ].join('\n'),
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};
