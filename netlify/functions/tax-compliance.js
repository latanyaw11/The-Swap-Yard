// ═══════════════════════════════════════════════════════════════
// The Swap Yard — Secure W-9 Storage + Tax Disclosure
// File: netlify/functions/tax-compliance.js
//
// SETUP:
//   npm install @supabase/supabase-js crypto
//
//   Netlify env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   W9_ENCRYPTION_KEY  → 32-char random string (generate once, never change)
//                        Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex').slice(0,32))"
//   ADMIN_EMAIL        → your email for compliance alerts
//
// SUPABASE TABLE (run in SQL Editor):
/*
  CREATE TABLE w9_records (
    id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id      uuid REFERENCES auth.users(id) UNIQUE,
    legal_name   text NOT NULL,
    business_name text,
    entity_type  text,
    address      text,
    city         text,
    state        text DEFAULT 'NC',
    zip          text,
    tin_type     text,
    tin_last4    text,          -- only last 4 digits stored in plain text
    tin_encrypted text,         -- AES-256 encrypted full TIN
    certified    bool DEFAULT false,
    submitted_at timestamptz DEFAULT now(),
    updated_at   timestamptz DEFAULT now()
  );
  ALTER TABLE w9_records ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "Users manage own w9" ON w9_records
    FOR ALL USING (auth.uid() = user_id);

  CREATE TABLE tax_estimates (
    id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id      uuid REFERENCES auth.users(id),
    listing_id   uuid,
    fmv_received numeric,
    fmv_given    numeric,
    bracket      numeric,
    estimated_tax numeric,
    saved_at     timestamptz DEFAULT now()
  );
  ALTER TABLE tax_estimates ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "Users manage own estimates" ON tax_estimates
    FOR ALL USING (auth.uid() = user_id);
*/
// ═══════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// AES-256-GCM encryption for TIN
function encryptTIN(tin) {
  const key   = Buffer.from(process.env.W9_ENCRYPTION_KEY || 'default-dev-key-32-chars-replace!', 'utf8').slice(0, 32);
  const iv    = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(tin.replace(/\D/g,''), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('hex'), authTag.toString('hex'), encrypted.toString('hex')].join(':');
}

function decryptTIN(encryptedData) {
  try {
    const [ivHex, authTagHex, dataHex] = encryptedData.split(':');
    const key      = Buffer.from(process.env.W9_ENCRYPTION_KEY || 'default-dev-key-32-chars-replace!', 'utf8').slice(0, 32);
    const iv       = Buffer.from(ivHex, 'hex');
    const authTag  = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (e) {
    return null;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 };
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
    const { action, ...params } = JSON.parse(event.body);
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // ── SUBMIT W-9 ──
    if (action === 'submit_w9') {
      const { userId, legalName, businessName, entityType, address, city, zip, tinType, tin, certified } = params;

      if (!userId || !legalName || !tin || !certified) {
        return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'Required fields missing' }) };
      }

      const rawTin = tin.replace(/\D/g, '');
      if (rawTin.length !== 9) {
        return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'TIN must be 9 digits' }) };
      }

      const tinLast4     = rawTin.slice(-4);
      const tinEncrypted = encryptTIN(rawTin);

      const { error } = await sb.from('w9_records').upsert({
        user_id:       userId,
        legal_name:    legalName,
        business_name: businessName || null,
        entity_type:   entityType,
        address,
        city,
        zip,
        tin_type:      tinType,
        tin_last4:     tinLast4,
        tin_encrypted: tinEncrypted,
        certified:     certified,
        submitted_at:  new Date().toISOString(),
        updated_at:    new Date().toISOString(),
      });

      if (error) throw error;

      // Mark user profile as tax-verified
      await sb.from('profiles').update({
        tax_consent: true,
        tax_name:    legalName,
        w9_on_file:  true,
      }).eq('id', userId);

      return {
        statusCode: 200, headers: h,
        body: JSON.stringify({ success: true, tinLast4, message: 'W-9 submitted and encrypted successfully' }),
      };
    }

    // ── CHECK W-9 STATUS ──
    if (action === 'check_w9') {
      const { userId } = params;
      const { data: w9 } = await sb.from('w9_records').select('tin_last4, tin_type, submitted_at, entity_type').eq('user_id', userId).single();

      return {
        statusCode: 200, headers: h,
        body: JSON.stringify({
          hasW9:       !!w9,
          tinLast4:    w9?.tin_last4,
          tinType:     w9?.tin_type,
          entityType:  w9?.entity_type,
          submittedAt: w9?.submitted_at,
        }),
      };
    }

    // ── SAVE TAX ESTIMATE ──
    if (action === 'save_estimate') {
      const { userId, listingId, fmvReceived, fmvGiven, bracket } = params;
      const estimatedTax = fmvReceived * bracket;

      await sb.from('tax_estimates').insert({
        user_id:       userId,
        listing_id:    listingId || null,
        fmv_received:  fmvReceived,
        fmv_given:     fmvGiven,
        bracket,
        estimated_tax: estimatedTax,
      });

      return { statusCode: 200, headers: h, body: JSON.stringify({ saved: true, estimatedTax }) };
    }

    // ── CHECK IF W-9 REQUIRED (based on trade FMV) ──
    if (action === 'check_w9_required') {
      const { userId, fmv } = params;
      const required = parseFloat(fmv) >= 600;

      if (!required) {
        return { statusCode: 200, headers: h, body: JSON.stringify({ required: false, message: 'W-9 not required for trades under $600' }) };
      }

      const { data: w9 } = await sb.from('w9_records').select('tin_last4').eq('user_id', userId).single();

      return {
        statusCode: 200, headers: h,
        body: JSON.stringify({
          required: true,
          hasW9:    !!w9,
          tinLast4: w9?.tin_last4,
          message:  w9
            ? `W-9 on file (TIN ending ${w9.tin_last4}) — you're set for this trade`
            : 'W-9 required for this trade. Please submit your tax information before proceeding.',
        }),
      };
    }

    // ── GENERATE 1099-B DATA (for tax filing service) ──
    if (action === 'generate_1099b') {
      const { userId, year } = params;
      const start = `${year}-01-01T00:00:00Z`;
      const end   = `${year}-12-31T23:59:59Z`;

      // Get W-9 for this user
      const { data: w9 } = await sb.from('w9_records').select('*').eq('user_id', userId).single();
      if (!w9) return { statusCode: 404, headers: h, body: JSON.stringify({ error: 'No W-9 on file' }) };

      // Get completed barters
      const { data: barters } = await sb.from('barter_transactions')
        .select('*, listings!listing_id_a(title), listings!listing_id_b(title)')
        .or(`user_a_id.eq.${userId},user_b_id.eq.${userId}`)
        .eq('status', 'completed')
        .gte('agreed_at', start).lte('agreed_at', end);

      const totalFmvReceived = (barters || []).reduce((sum, b) => {
        const isA = b.user_a_id === userId;
        return sum + (isA ? (b.fmv_b || 0) : (b.fmv_a || 0));
      }, 0);

      const form1099bData = {
        payerName:    'The Swap Yard',
        payerTIN:     process.env.PAYER_TIN || 'XX-XXXXXXX',
        payerAddress: 'Research Triangle Park, NC 27709',
        recipientName: w9.legal_name,
        recipientTIN:  `***-**-${w9.tin_last4}`,  // masked for display
        recipientAddress: `${w9.address}, ${w9.city}, NC ${w9.zip}`,
        taxYear:       year,
        grossProceeds: totalFmvReceived.toFixed(2),
        transactions:  (barters || []).map(b => {
          const isA = b.user_a_id === userId;
          const fmvRcvd = isA ? b.fmv_b : b.fmv_a;
          const fmvGiven = isA ? b.fmv_a : b.fmv_b;
          return {
            date:        b.agreed_at?.split('T')[0],
            description: 'Barter Exchange',
            fmvReceived: fmvRcvd,
            fmvGiven,
            gainLoss:    (fmvRcvd || 0) - (fmvGiven || 0),
          };
        }),
        requiresFiling: totalFmvReceived > 0,
        filingDeadline: `${parseInt(year) + 1}-02-15`,
      };

      return { statusCode: 200, headers: h, body: JSON.stringify(form1099bData) };
    }

    return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};
