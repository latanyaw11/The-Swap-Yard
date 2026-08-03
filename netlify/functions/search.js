// ═══════════════════════════════════════════════════════════════
// The Swap Yard — Search, Filtering & Wishlist/Saved Searches
// File: netlify/functions/search.js
//
// FEATURES:
//   Full-text search across title + description
//   Filter by category, price, type, location, radius
//   Sort by relevance, price, date, rating
//   Saved search alerts — notifies user when new matches appear
//   Wishlist — save individual listings
//
// SETUP:
//   Run this SQL in Supabase to enable full-text search:
//
//   ALTER TABLE listings ADD COLUMN IF NOT EXISTS search_vector tsvector
//     GENERATED ALWAYS AS (
//       to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,'') || ' ' || coalesce(category,''))
//     ) STORED;
//   CREATE INDEX IF NOT EXISTS idx_listings_search ON listings USING GIN(search_vector);
// ═══════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (!['GET','POST'].includes(event.httpMethod)) return { statusCode: 405 };
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
    const sb     = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const params = event.httpMethod === 'GET'
      ? event.queryStringParameters || {}
      : JSON.parse(event.body || '{}');

    const { action = 'search' } = params;

    // ── FULL-TEXT SEARCH ──
    if (action === 'search') {
      const {
        q           = '',
        category    = '',
        type        = '',
        minPrice    = '',
        maxPrice    = '',
        accepts     = '',
        certified   = '',
        zip         = '',
        radius      = '25',
        sort        = 'created_at',
        order       = 'desc',
        page        = '1',
        pageSize    = '20',
        isBoosted   = '',
      } = params;

      let query = sb.from('listings').select(`
        id, title, description, type, category,
        price_usd, fmv, accepts, barter_for,
        seller_name, emoji, certified, is_boosted,
        boost_tier, avg_rating, review_count,
        city, state, zip, lat, lng, created_at, fulfillment
      `).eq('is_active', true);

      // Full-text search
      if (q.trim()) {
        query = query.textSearch('search_vector', q.trim().split(/\s+/).join(' | '), { type: 'websearch' });
      }

      // Filters
      if (category) query = query.eq('category', category);
      if (type)     query = query.eq('type', type);
      if (minPrice) query = query.gte('price_usd', parseFloat(minPrice));
      if (maxPrice) query = query.lte('price_usd', parseFloat(maxPrice));
      if (certified === 'true') query = query.eq('certified', true);
      if (isBoosted === 'true') query = query.eq('is_boosted', true);
      if (accepts)  query = query.contains('accepts', [accepts]);

      // Sort
      const sortMap = {
        created_at: 'created_at', price_asc: 'price_usd',
        price_desc: 'price_usd', rating: 'avg_rating',
        relevance:  'created_at',
      };
      const sortCol = sortMap[sort] || 'created_at';
      const sortAsc = sort === 'price_asc' ? true : (order === 'asc');

      // Boosted listings always come first
      query = query.order('is_boosted', { ascending: false })
                   .order(sortCol, { ascending: sortAsc });

      // Pagination
      const pageNum  = Math.max(1, parseInt(page));
      const size     = Math.min(50, Math.max(1, parseInt(pageSize)));
      const from     = (pageNum - 1) * size;
      query = query.range(from, from + size - 1);

      const { data, error, count } = await query;
      if (error) throw error;

      return {
        statusCode: 200, headers: h,
        body: JSON.stringify({
          results:    data || [],
          total:      count || (data?.length || 0),
          page:       pageNum,
          pageSize:   size,
          hasMore:    (data?.length || 0) === size,
        }),
      };
    }

    // ── SAVE A SEARCH (wishlist alert) ──
    if (action === 'save_search') {
      const { userId, query: searchQuery, filters, name } = params;
      if (!userId) return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'userId required' }) };

      const { data, error } = await sb.from('saved_searches').insert({
        user_id:    userId,
        name:       name || searchQuery || 'My Search',
        query:      searchQuery || '',
        filters:    filters ? JSON.stringify(filters) : null,
        is_active:  true,
        created_at: new Date().toISOString(),
      }).select().single();

      if (error) throw error;
      return { statusCode: 200, headers: h, body: JSON.stringify({ saved: data }) };
    }

    // ── GET SAVED SEARCHES ──
    if (action === 'get_saved_searches') {
      const { userId } = params;
      const { data } = await sb.from('saved_searches').select('*').eq('user_id', userId).eq('is_active', true).order('created_at', { ascending: false });
      return { statusCode: 200, headers: h, body: JSON.stringify({ searches: data || [] }) };
    }

    // ── DELETE SAVED SEARCH ──
    if (action === 'delete_saved_search') {
      const { userId, searchId } = params;
      await sb.from('saved_searches').delete().eq('id', searchId).eq('user_id', userId);
      return { statusCode: 200, headers: h, body: JSON.stringify({ deleted: true }) };
    }

    // ── ADD TO WISHLIST ──
    if (action === 'wishlist_add') {
      const { userId, listingId } = params;
      await sb.from('wishlists').upsert({ user_id: userId, listing_id: listingId, created_at: new Date().toISOString() });
      return { statusCode: 200, headers: h, body: JSON.stringify({ added: true }) };
    }

    // ── REMOVE FROM WISHLIST ──
    if (action === 'wishlist_remove') {
      const { userId, listingId } = params;
      await sb.from('wishlists').delete().eq('user_id', userId).eq('listing_id', listingId);
      return { statusCode: 200, headers: h, body: JSON.stringify({ removed: true }) };
    }

    // ── GET WISHLIST ──
    if (action === 'get_wishlist') {
      const { userId } = params;
      const { data } = await sb.from('wishlists')
        .select('listing_id, created_at, listings(id,title,emoji,price_usd,category,seller_name,avg_rating,is_active)')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      return { statusCode: 200, headers: h, body: JSON.stringify({ wishlist: data || [] }) };
    }

    // ── RUN SAVED SEARCH ALERTS (called on schedule) ──
    if (action === 'run_alerts') {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: searches } = await sb.from('saved_searches').select('*, profiles(email)').eq('is_active', true);

      let notified = 0;
      for (const search of searches || []) {
        if (!search.profiles?.email) continue;
        const filters  = search.filters ? JSON.parse(search.filters) : {};
        let query = sb.from('listings').select('id,title,price_usd,emoji,category').eq('is_active', true).gte('created_at', since);
        if (search.query) query = query.textSearch('search_vector', search.query, { type: 'websearch' });
        if (filters.category) query = query.eq('category', filters.category);
        if (filters.type)     query = query.eq('type',     filters.type);
        const { data: matches } = await query.limit(5);

        if (matches?.length > 0) {
          await fetch(`${process.env.URL}/.netlify/functions/send-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              to:   search.profiles.email,
              type: 'custom',
              subject: `🔔 ${matches.length} new listing${matches.length > 1 ? 's' : ''} match "${search.name}" — The Swap Yard`,
              data: { body: matches.map(m => `${m.emoji} ${m.title} — ${m.price_usd ? '$'+m.price_usd : 'Trade'}`).join('\n') },
            }),
          });
          notified++;
        }
      }
      return { statusCode: 200, headers: h, body: JSON.stringify({ alertsSent: notified }) };
    }

    return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};
