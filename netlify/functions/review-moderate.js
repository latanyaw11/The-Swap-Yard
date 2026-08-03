// ═══════════════════════════════════════════════════════════════
// The Swap Yard — Review Moderation
// File: netlify/functions/review-moderate.js
//
// WHAT IT DOES:
//   Automatically screens reviews for:
//   - Prohibited words (hate speech, slurs, threats)
//   - Spam patterns (repeated characters, all caps, URLs)
//   - Suspiciously low ratings with no text (possible abuse)
//   - Fake-positive patterns (generic 5-star spam)
//
//   Flagged reviews are hidden from public view pending admin approval.
//   Clean reviews are published immediately.
//
// CALLED:
//   - Automatically after every new review is submitted
//   - Manually via GET for bulk re-moderation
//   - Admin can approve/reject flagged reviews via PATCH
//
// ENV VARS: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_EMAIL, RESEND_API_KEY
// ═══════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

// Words that auto-hide a review pending admin review
const PROHIBITED_PATTERNS = [
  /\b(scam|fraud|fake|stolen|illegal)\b/i,
  /\b(kill|threat|hate|racist|slur)\b/i,
  /https?:\/\//i,           // URLs in reviews
  /(.)\1{6,}/,              // Repeated characters (aaaaaaa)
  /[A-Z\s]{30,}/,           // All caps long strings (SPAM SPAM SPAM)
];

// Spam/fake positive signals (don't auto-hide but flag for review)
const SUSPICIOUS_PATTERNS = [
  /^(great|amazing|excellent|perfect|wonderful|fantastic)[\s!.]*$/i,
  /^5\/5[\s!.]*$/i,
  /bought this for my (wife|husband|mom|dad)/i,
];

function moderateReview(text = '', rating) {
  const flags = [];
  let autoHide = false;

  if (!text || text.trim().length < 3) {
    if (rating <= 2) {
      flags.push({ type: 'NO_TEXT_LOW_RATING', severity: 'MEDIUM', detail: 'Low rating submitted with no explanation' });
    }
  }

  for (const pattern of PROHIBITED_PATTERNS) {
    if (pattern.test(text)) {
      flags.push({ type: 'PROHIBITED_CONTENT', severity: 'HIGH', detail: `Matched pattern: ${pattern.toString()}` });
      autoHide = true;
      break;
    }
  }

  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(text.trim())) {
      flags.push({ type: 'SUSPICIOUS_PATTERN', severity: 'LOW', detail: 'Looks like generic/spam review' });
    }
  }

  if (text.length > 2000) {
    flags.push({ type: 'TOO_LONG', severity: 'LOW', detail: 'Review exceeds 2000 characters' });
  }

  return { flags, autoHide, clean: flags.length === 0 };
}

exports.handler = async (event) => {
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // ── MODERATE A SINGLE NEW REVIEW ──
  if (event.httpMethod === 'POST') {
    try {
      const { reviewId, text, rating, listingId, reviewerId } = JSON.parse(event.body);
      if (!reviewId) return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'reviewId required' }) };

      const result = moderateReview(text, rating);

      // Update review visibility
      await sb.from('reviews').update({
        is_visible:      !result.autoHide,
        moderation_flags: JSON.stringify(result.flags),
        moderated_at:    new Date().toISOString(),
      }).eq('id', reviewId);

      // Alert admin for high-severity flags
      const highFlags = result.flags.filter(f => f.severity === 'HIGH');
      if (highFlags.length && process.env.ADMIN_EMAIL && process.env.RESEND_API_KEY) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from:    process.env.FROM_EMAIL || 'noreply@theswapyard.com',
            to:      process.env.ADMIN_EMAIL,
            subject: `⚠️ Review flagged for moderation — ${reviewId}`,
            html:    `<p>Review <strong>${reviewId}</strong> was auto-hidden.</p><p>Text: "${text?.slice(0,200)}"</p><p>Flags: ${highFlags.map(f=>f.detail).join(', ')}</p><p>Rating: ${rating}/5</p>`,
          }),
        });
      }

      return {
        statusCode: 200, headers: h,
        body: JSON.stringify({ reviewId, visible: !result.autoHide, flags: result.flags, clean: result.clean }),
      };
    } catch (e) {
      return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
    }
  }

  // ── ADMIN: APPROVE OR REJECT A REVIEW ──
  if (event.httpMethod === 'PATCH') {
    try {
      const { reviewId, action } = JSON.parse(event.body);
      if (!reviewId || !['approve','reject'].includes(action)) {
        return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'reviewId and action (approve|reject) required' }) };
      }
      await sb.from('reviews').update({
        is_visible:    action === 'approve',
        admin_reviewed: true,
        moderated_at:  new Date().toISOString(),
      }).eq('id', reviewId);
      return { statusCode: 200, headers: h, body: JSON.stringify({ reviewId, action, done: true }) };
    } catch (e) {
      return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
    }
  }

  // ── BULK RE-MODERATION (GET) ──
  if (event.httpMethod === 'GET') {
    try {
      // Get recent unmoderated reviews
      const { data: reviews } = await sb.from('reviews')
        .select('id, text, rating')
        .is('moderation_flags', null)
        .limit(100);

      let processed = 0;
      let hidden    = 0;
      for (const review of reviews || []) {
        const result = moderateReview(review.text, review.rating);
        await sb.from('reviews').update({
          is_visible:       !result.autoHide,
          moderation_flags: JSON.stringify(result.flags),
          moderated_at:     new Date().toISOString(),
        }).eq('id', review.id);
        processed++;
        if (result.autoHide) hidden++;
      }
      return { statusCode: 200, headers: h, body: JSON.stringify({ processed, hidden }) };
    } catch (e) {
      return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
    }
  }

  return { statusCode: 405, headers: h, body: JSON.stringify({ error: 'Method not allowed' }) };
};
