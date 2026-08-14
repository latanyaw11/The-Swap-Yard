// ═══════════════════════════════════════════════════════════════
// The Swap Yard — Send Push Notification
// File: netlify/functions/send-push.js
// ═══════════════════════════════════════════════════════════════

const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

webpush.setVapidDetails(
  process.env.VAPID_EMAIL,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 };
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
    const { userId, title, body, url, type } = JSON.parse(event.body);

    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Get all push subscriptions for this user
    const { data: subs } = await sb
      .from('push_subscriptions')
      .select('subscription')
      .eq('user_id', userId);

    if (!subs || !subs.length) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ sent: 0 }) };
    }

    const payload = JSON.stringify({
      title: title || 'The Swap Yard',
      body:  body  || 'You have a new notification',
      url:   url   || '/mobile.html',
      type:  type  || 'general',
      tag:   type  || 'swapyard',
      actions: [
        { action: 'view',    title: 'View' },
        { action: 'dismiss', title: 'Dismiss' },
      ],
    });

    const results = await Promise.allSettled(
      subs.map(s => webpush.sendNotification(s.subscription, payload))
    );

    // Remove expired subscriptions
    const expired = subs.filter((_, i) =>
      results[i].status === 'rejected' &&
      results[i].reason?.statusCode === 410
    );
    if (expired.length) {
      await Promise.all(expired.map(s =>
        sb.from('push_subscriptions')
          .delete()
          .eq('user_id', userId)
          .eq('subscription->endpoint', s.subscription.endpoint)
      ));
    }

    const sent = results.filter(r => r.status === 'fulfilled').length;
    return { statusCode: 200, headers: h, body: JSON.stringify({ sent }) };

  } catch (e) {
    console.error(e);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};
