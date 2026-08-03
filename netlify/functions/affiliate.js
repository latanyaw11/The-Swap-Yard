// ═══════════════════════════════════════════════════════════════
// The Swap Yard — Affiliate Marketing Engine
// File: netlify/functions/affiliate.js
//
// SETUP — Add these to Netlify Environment Variables:
//   AMAZON_AFFILIATE_TAG      → yoursite-20
//   EBAY_CAMPAIGN_ID          → your eBay campaign ID
//   SHAREASALE_AFFILIATE_ID   → your ShareASale ID
//
// HOW IT WORKS:
//   1. Listing detail modal opens
//   2. Frontend calls /.netlify/functions/affiliate?category=Music+%26+Audio&title=Fender+Stratocaster
//   3. This function returns 1-3 relevant affiliate links
//   4. Those appear as "Buy new at..." cards below the listing
//   5. Clicks are tracked in Supabase for your reporting
// ═══════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

// ── AFFILIATE PROGRAM REGISTRY ────────────────────────────────
// Add your tracking IDs after signing up to each program
const AFFILIATES = {
  amazon: {
    name:    'Amazon',
    tag:     process.env.AMAZON_AFFILIATE_TAG || 'theswapyard-20',
    logo:    '🛒',
    color:   '#FF9900',
    baseUrl: 'https://www.amazon.com/s',
    buildUrl: (query, tag) =>
      `https://www.amazon.com/s?k=${encodeURIComponent(query)}&tag=${tag}`,
  },
  ebay: {
    name:    'eBay',
    logo:    '🏷️',
    color:   '#e53238',
    buildUrl: (query, campaignId) =>
      `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&campid=${campaignId || process.env.EBAY_CAMPAIGN_ID || ''}`,
  },
  guitarcenter: {
    name:    'Guitar Center',
    logo:    '🎸',
    color:   '#c8102e',
    buildUrl: (query) =>
      `https://www.guitarcenter.com/search?typeAheadSuggestion=true&q=${encodeURIComponent(query)}`,
  },
  reverb: {
    name:    'Reverb',
    logo:    '🎵',
    color:   '#e45526',
    buildUrl: (query) =>
      `https://reverb.com/marketplace?query=${encodeURIComponent(query)}`,
  },
  bhphoto: {
    name:    'B&H Photo',
    logo:    '📷',
    color:   '#003087',
    buildUrl: (query) =>
      `https://www.bhphotovideo.com/c/search?Ntt=${encodeURIComponent(query)}`,
  },
  homedepot: {
    name:    'Home Depot',
    logo:    '🔨',
    color:   '#f96302',
    buildUrl: (query) =>
      `https://www.homedepot.com/s/${encodeURIComponent(query)}`,
  },
  etsy: {
    name:    'Etsy',
    logo:    '🎨',
    color:   '#f56400',
    buildUrl: (query) =>
      `https://www.etsy.com/search?q=${encodeURIComponent(query)}`,
  },
};

// ── CATEGORY → AFFILIATE MAPPING ─────────────────────────────
// Maps your listing categories to the most relevant affiliate programs
const CATEGORY_MAP = {
  'Music & Audio':          ['guitarcenter', 'reverb', 'amazon'],
  'Electronics':            ['bhphoto', 'amazon', 'ebay'],
  'Cameras & Photography':  ['bhphoto', 'amazon', 'ebay'],
  'Tools & Hardware':       ['homedepot', 'amazon', 'ebay'],
  'Home & Garden':          ['homedepot', 'amazon', 'etsy'],
  'Art & Collectibles':     ['etsy', 'ebay', 'amazon'],
  'Fashion & Apparel':      ['ebay', 'amazon', 'etsy'],
  'Sports & Fitness':       ['amazon', 'ebay'],
  'Books & Media':          ['amazon', 'ebay'],
  'Vehicles & Automotive':  ['ebay', 'amazon'],
  'Toys & Games':           ['amazon', 'ebay'],
  'Baby & Kids':            ['amazon', 'ebay'],
  'Health & Wellness':      ['amazon'],
  'Office & Business':      ['amazon', 'ebay'],
  'Other':                  ['amazon', 'ebay'],
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405 };
  const h = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=3600', // cache for 1 hour
  };

  try {
    const { category = 'Other', title = '', listingId, userId } = event.queryStringParameters || {};

    // Build search query from listing title (clean up common words)
    const stopWords = ['used', 'vintage', 'great', 'condition', 'excellent', 'good', 'fair', 'like new', 'og', 'original'];
    const query = title
      .split(' ')
      .filter(w => w.length > 2 && !stopWords.includes(w.toLowerCase()))
      .slice(0, 5)
      .join(' ')
      .trim() || category;

    // Get affiliate programs for this category
    const programs  = CATEGORY_MAP[category] || CATEGORY_MAP['Other'];
    const maxLinks  = 3;
    const links     = [];

    for (const programKey of programs.slice(0, maxLinks)) {
      const program = AFFILIATES[programKey];
      if (!program) continue;

      let url;
      if (programKey === 'amazon') {
        url = program.buildUrl(query, program.tag);
      } else if (programKey === 'ebay') {
        url = program.buildUrl(query, process.env.EBAY_CAMPAIGN_ID);
      } else {
        url = program.buildUrl(query);
      }

      links.push({
        key:   programKey,
        name:  program.name,
        logo:  program.logo,
        color: program.color,
        url,
        label: `Buy new at ${program.name}`,
      });
    }

    // Log the affiliate link impression (non-blocking)
    if (listingId && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      sb.from('affiliate_impressions').insert({
        listing_id: listingId,
        user_id:    userId || null,
        category,
        programs:   programs.slice(0, maxLinks),
        created_at: new Date().toISOString(),
      }).then(() => {}).catch(() => {});
    }

    return { statusCode: 200, headers: h, body: JSON.stringify({ links, query }) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, headers: h, body: JSON.stringify({ links: [] }) };
  }
};
