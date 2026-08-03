// ═══════════════════════════════════════════════════════════════
// The Swap Yard — Push Notification Sender
// File: netlify/functions/push-notify.js
//
// SETUP:
//   Generate VAPID keys: npx web-push generate-vapid-keys
//   Add to Netlify env vars:
//     VAPID_PUBLIC_KEY   → long base64 string
//     VAPID_PRIVATE_KEY  → long base64 string
//     VAPID_EMAIL        → mailto:admin@theswapyard.com
//
// USAGE — call from other functions:
//   POST /.netlify/functions/push-notify
//   Body: { userId, type, title, body, url, image }
//
// NOTIFICATION TYPES:
//   new_message       → Someone sent you a message
//   trade_offer       → You received a trade proposal
//   order_shipped     → Your order has shipped
//   listing_match     → New listing matches your saved search
//   boost_expired     → Your listing boost is expiring soon
//   referral_earned   → You earned a referral credit
//   custom            → Custom title/body
// ═══════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');
const webpush = require('web-push');

// Configure VAPID
webpush.setVapidDetails(
  process.env.VAPID_EMAIL || 'mailto:admin@theswapyard.com',
  process.env.VAPID_PUBLIC_KEY  || '',
  process.env.VAPID_PRIVATE_KEY || ''
);

// Notification templates
const TEMPLATES = {
  new_message: (data) => ({
    title: `💬 New message from ${data.senderName || 'a buyer'}`,
    body:  data.preview ? `"${data.preview.slice(0, 80)}..."` : 'Open to read',
    icon:  '/icons/icon-192.png',
    badge: '/icons/icon-72.png',
    url:   '/vendor-dashboard.html',
    tag:   'message',
  }),
  trade_offer: (data) => ({
    title: `⇄ New trade offer on "${data.listingTitle || 'your listing'}"`,
    body:  `${data.offerName || 'Someone'} wants to trade — tap to review`,
    icon:  '/icons/icon-192.png',
    badge: '/icons/icon-72.png',
    url:   '/vendor-dashboard.html',
    tag:   'trade',
  }),
  order_shipped: (data) => ({
    title: `📦 Your order is on the way!`,
    body:  `Tracking: ${data.trackingCode || 'See dashboard'} via ${data.carrier || 'carrier'}`,
    icon:  '/icons/icon-192.png',
    badge: '/icons/icon-72.png',
    url:   '/vendor-dashboard.html',
    tag:   'shipping',
  }),
  listing_match: (data) => ({
    title: `🔔 New listing matches "${data.searchName || 'your saved search'}"`,
    body:  `${data.count || 'New'} listing${data.count !== 1 ? 's' : ''} found — tap to browse`,
    icon:  '/icons/icon-192.png',
    badge: '/icons/icon-72.png',
    url:   '/index.html',
    tag:   'search-alert',
  }),
  boost_expired: (data) => ({
    title: `🚀 Your boost on "${data.listingTitle || 'a listing'}" expired`,
    body:  'Renew your boost to stay at the top of search results',
    icon:  '/icons/icon-192.png',
    badge: '/icons/icon-72.png',
    url:   '/vendor-dashboard.html',
    tag:   'boost',
  }),
  referral_earned: (data) => ({
    title: `🎁 You earned a $${((data.credits || 500) / 100).toFixed(2)} referral credit!`,
    body:  `${data.referredName || 'Someone'} joined using your link`,
    icon:  '/icons/icon-192.png',
    badge: '/icons/icon-72.png',
    url:   '/vendor-dashboard.html',
    tag:   'referral',
  }),
  custom: (data) => ({
    title: data.title || 'The Swap Yard',
    body:  data.body  || '',
    icon:  '/icons/icon-192.png',
    badge: '/icons/icon-72.png',
    url:   data.url   || '/',
    tag:   data.tag   || 'general',
  }),
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 };
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
    const { userId, userIds, type = 'custom', data = {}, broadcast = false } = JSON.parse(event.body);

    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
      return { statusCode: 503, headers: h, body: JSON.stringify({ error: 'VAPID keys not configured. Add VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to Netlify env vars.' }) };
    }

    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // Get subscriptions
    let query = sb.from('push_subscriptions').select('user_id, subscription');
    if (broadcast) {
      // Send to all subscribers (use sparingly)
      // No filter
    } else if (userIds?.length) {
      query = query.in('user_id', userIds);
    } else if (userId) {
      query = query.eq('user_id', userId);
    } else {
      return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'userId, userIds, or broadcast:true required' }) };
    }

    const { data: subs, error } = await query;
    if (error) throw error;
    if (!subs?.length) return { statusCode: 200, headers: h, body: JSON.stringify({ sent: 0, message: 'No subscribers found' }) };

    // Build notification payload
    const template = TEMPLATES[type] || TEMPLATES.custom;
    const notification = template(data);
    const payload = JSON.stringify({
      title:   notification.title,
      body:    notification.body,
      icon:    notification.icon,
      badge:   notification.badge,
      tag:     notification.tag,
      data:    { url: (process.env.URL || '') + notification.url, type },
      actions: [
        { action: 'view',    title: 'View Now' },
        { action: 'dismiss', title: 'Dismiss'  },
      ],
    });

    // Send to all matching subscribers
    const results = await Promise.allSettled(
      subs.map(async (sub) => {
        try {
          const subscription = typeof sub.subscription === 'string'
            ? JSON.parse(sub.subscription)
            : sub.subscription;
          await webpush.sendNotification(subscription, payload);
          return { userId: sub.user_id, sent: true };
        } catch (e) {
          // If subscription is expired/invalid, remove it
          if (e.statusCode === 410 || e.statusCode === 404) {
            await sb.from('push_subscriptions').delete().eq('user_id', sub.user_id);
          }
          return { userId: sub.user_id, sent: false, error: e.message };
        }
      })
    );

    const sent   = results.filter(r => r.value?.sent).length;
    const failed = results.filter(r => !r.value?.sent).length;

    return {
      statusCode: 200, headers: h,
      body: JSON.stringify({ sent, failed, total: subs.length }),
    };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};
