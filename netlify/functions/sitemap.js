// ═══════════════════════════════════════════════════════════════
// The Swap Yard — Dynamic XML Sitemap Generator
// File: netlify/functions/sitemap.js
//
// SETUP — Add redirect in netlify.toml:
//   [[redirects]]
//     from   = "/sitemap.xml"
//     to     = "/.netlify/functions/sitemap"
//     status = 200
//
// WHAT IT DOES:
//   Generates a valid XML sitemap including:
//   - All static pages (index, terms, tax-guide, etc.)
//   - All active listings (individual listing URLs)
//   - All active event listings
//   - Category browse pages
//   - Cached for 1 hour so search engines get fast responses
//
// WHY THIS MATTERS:
//   Google and Bing use sitemaps to discover and index your pages.
//   Without one, listings may not appear in search results for days
//   or weeks after being posted. With a dynamic sitemap, new listings
//   can be indexed within hours.
//
// ALSO GENERATES:
//   GET /sitemap.xml → full XML sitemap
//   GET /?format=json → JSON version for debugging
//
// ENV VARS: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or ANON_KEY), URL
// ═══════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

const STATIC_PAGES = [
  { url: '/',                      changefreq: 'hourly',  priority: '1.0' },
  { url: '/index.html',            changefreq: 'hourly',  priority: '1.0' },
  { url: '/vendor-dashboard.html', changefreq: 'daily',   priority: '0.6' },
  { url: '/terms.html',            changefreq: 'monthly', priority: '0.5' },
  { url: '/tax-guide.html',        changefreq: 'monthly', priority: '0.7' },
];

const CATEGORIES = [
  'Music & Audio', 'Electronics', 'Cameras & Photography', 'Tools & Hardware',
  'Home & Garden', 'Art & Collectibles', 'Fashion & Apparel', 'Sports & Fitness',
  'Books & Media', 'Vehicles & Automotive', 'Toys & Games', 'Health & Wellness',
];

function escapeXml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

exports.handler = async (event) => {
  const baseUrl = process.env.URL || 'https://theswapyard.com';
  const wantsJson = event.queryStringParameters?.format === 'json';

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY);

    // Fetch all active listings (just id, updated_at, category, type)
    const { data: listings } = await sb
      .from('listings')
      .select('id, updated_at, category, type, title')
      .eq('is_active', true)
      .order('updated_at', { ascending: false })
      .limit(5000); // Sitemap limit

    const now = new Date().toISOString().split('T')[0];

    // Build URLs list
    const urls = [];

    // Static pages
    for (const page of STATIC_PAGES) {
      urls.push({ loc: baseUrl + page.url, lastmod: now, changefreq: page.changefreq, priority: page.priority });
    }

    // Category pages
    for (const cat of CATEGORIES) {
      urls.push({
        loc:        `${baseUrl}/index.html?category=${encodeURIComponent(cat)}`,
        lastmod:    now,
        changefreq: 'daily',
        priority:   '0.8',
      });
    }

    // Individual listings
    for (const listing of listings || []) {
      urls.push({
        loc:        `${baseUrl}/index.html?listing=${listing.id}`,
        lastmod:    listing.updated_at ? listing.updated_at.split('T')[0] : now,
        changefreq: listing.type === 'event' ? 'daily' : 'weekly',
        priority:   listing.type === 'event' ? '0.9' : '0.7',
        title:      listing.title,
      });
    }

    if (wantsJson) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ total: urls.length, urls }),
      };
    }

    // Build XML
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.map(u => `  <url>
    <loc>${escapeXml(u.loc)}</loc>
    <lastmod>${escapeXml(u.lastmod)}</lastmod>
    <changefreq>${escapeXml(u.changefreq)}</changefreq>
    <priority>${escapeXml(u.priority)}</priority>
  </url>`).join('\n')}
</urlset>`;

    return {
      statusCode: 200,
      headers: {
        'Content-Type':  'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=3600', // Cache 1 hour
        'X-Robots-Tag':  'noindex',              // Don't index the function itself
      },
      body: xml,
    };
  } catch (e) {
    console.error(e);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/xml' },
      body: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${STATIC_PAGES.map(p=>`<url><loc>${baseUrl}${p.url}</loc></url>`).join('')}</urlset>`,
    };
  }
};
