// ═══════════════════════════════════════════════════════════════
// SwapYard — Vendor Orders & Revenue API
// File: netlify/functions/vendor-data.js
//
// Returns orders, revenue stats, and tracking info for a vendor.
// Called from the vendor dashboard in the browser.
// ═══════════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405 };
  const h = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // Get vendor ID from query param (their Supabase user ID)
    const userId = event.queryStringParameters?.userId;
    if (!userId) return { statusCode: 400, headers: h, body: JSON.stringify({ error: 'userId required' }) };

    // Fetch all orders for this vendor's listings
    const { data: orders, error: ordersErr } = await sb
      .from('orders')
      .select(`
        id, listing_id, buyer_email, amount_total,
        platform_fee, vendor_earnings, status,
        tracking_code, tracking_url, carrier,
        shipping_status, created_at,
        listings ( title, emoji, category )
      `)
      .eq('vendor_user_id', userId)
      .order('created_at', { ascending: false });

    if (ordersErr) throw ordersErr;

    // Fetch revenue summary
    const { data: stats } = await sb
      .from('vendor_stats')
      .select('*')
      .eq('user_id', userId)
      .single();

    // Compute summary from orders
    const summary = {
      totalOrders:    orders?.length || 0,
      totalRevenue:   orders?.reduce((s, o) => s + (o.vendor_earnings || 0), 0).toFixed(2),
      pendingOrders:  orders?.filter(o => o.status === 'paid' && !o.tracking_code).length || 0,
      shippedOrders:  orders?.filter(o => o.shipping_status === 'shipped').length || 0,
      deliveredOrders:orders?.filter(o => o.shipping_status === 'delivered').length || 0,
      lastSaleDate:   stats?.last_sale_at || null,
    };

    return {
      statusCode: 200,
      headers: h,
      body: JSON.stringify({ orders: orders || [], summary }),
    };
  } catch (e) {
    return { statusCode: 500, headers: h, body: JSON.stringify({ error: e.message }) };
  }
};
