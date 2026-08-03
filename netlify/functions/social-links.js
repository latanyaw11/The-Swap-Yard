// The Swap Yard — Social Links Handler
// Saves vendor social media links and website URLs to their profile
const { createClient } = require('@supabase/supabase-js');
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405 };
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  try {
    const { userId, website, instagram, facebook, tiktok, twitter, youtube } = JSON.parse(event.body);
    if (!userId) return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'userId required' }) };
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const links = { website, instagram, facebook, tiktok, twitter, youtube };
    // Remove null/empty
    Object.keys(links).forEach(k => !links[k] && delete links[k]);
    const { error } = await sb.from('profiles').upsert({ id: userId, social_links: links });
    if (error) throw error;
    return { statusCode: 200, headers: h, body: JSON.stringify({ saved: true, links }) };
  } catch (e) {
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};
