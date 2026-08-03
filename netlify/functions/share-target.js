// ═══════════════════════════════════════════════════════════════
// The Swap Yard — PWA Web Share Target Handler
// File: netlify/functions/share-target.js
//
// SETUP — Already configured in manifest.json:
//   "share_target": {
//     "action": "/share-target",
//     "method": "GET",
//     "params": { "title": "title", "text": "text", "url": "url" }
//   }
//
// Add redirect in netlify.toml (already included):
//   [[redirects]]
//     from   = "/share-target"
//     to     = "/.netlify/functions/share-target"
//     status = 200
//
// WHAT IT DOES:
//   When a user shares content TO The Swap Yard from another app
//   (e.g. shares a product link from Instagram or a screenshot),
//   this handler receives the shared data and redirects to the
//   listing creation form with fields pre-filled.
//
// EXAMPLE FLOW:
//   User is on Instagram, sees a product → taps Share → selects
//   "The Swap Yard" → they're taken to the new listing form
//   with the product URL, title, and text pre-filled.
//
// ALSO HANDLES:
//   Sharing FROM The Swap Yard — Web Share API lets vendors
//   share their listings to other apps via the native share sheet.
// ═══════════════════════════════════════════════════════════════

exports.handler = async (event) => {
  // Receive shared content
  const params  = event.queryStringParameters || {};
  const title   = params.title || '';
  const text    = params.text  || '';
  const url     = params.url   || '';

  const baseUrl = process.env.URL || 'https://theswapyard.com';

  // Build a redirect to the listing creation flow with pre-filled data
  const listingParams = new URLSearchParams();
  if (title) listingParams.set('prefill_title',       title.slice(0, 100));
  if (text)  listingParams.set('prefill_description', text.slice(0, 500));
  if (url)   listingParams.set('prefill_source_url',  url);
  listingParams.set('action', 'new_listing');

  const redirectUrl = `${baseUrl}/index.html?${listingParams.toString()}`;

  // Return a redirect page (302 doesn't work well from PWA share targets)
  // Instead we return a minimal HTML page that auto-redirects
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Opening The Swap Yard…</title>
<meta http-equiv="refresh" content="0;url=${redirectUrl}">
<style>
  body { background:#ffffff; color:#111827; font-family:Inter,sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; text-align:center; }
  .logo { font-size:1.2rem; font-weight:900; margin-bottom:1rem; }
  .logo span { color:#7c3aed; }
  p { color:#9ca3af; font-size:.85rem; }
  .spinner { width:32px; height:32px; border:3px solid rgba(124,58,237,.2); border-top-color:#7c3aed; border-radius:50%; animation:spin .8s linear infinite; margin:0 auto 1rem; }
  @keyframes spin { to { transform:rotate(360deg); } }
</style>
</head>
<body>
<div>
  <div class="spinner" aria-hidden="true"></div>
  <div class="logo"><span>The Swap</span> Yard</div>
  <p>Opening listing form…</p>
  <script>
    // Pre-fill listing form after redirect
    sessionStorage.setItem('tsy_share_prefill', JSON.stringify({
      title:       ${JSON.stringify(title)},
      description: ${JSON.stringify(text)},
      sourceUrl:   ${JSON.stringify(url)},
    }));
    window.location.href = ${JSON.stringify(redirectUrl)};
  </script>
</div>
</body>
</html>`,
  };
};

// ── COMPANION: Read pre-fill in index.html ────────────────────
// Add this script to index.html to pick up shared content:
//
// document.addEventListener('DOMContentLoaded', () => {
//   const prefill = sessionStorage.getItem('tsy_share_prefill');
//   if (prefill) {
//     try {
//       const data = JSON.parse(prefill);
//       sessionStorage.removeItem('tsy_share_prefill');
//       // Open new listing form pre-filled
//       if (data.title || data.description) {
//         openNewListing();
//         document.getElementById('nl-title').value       = data.title || '';
//         document.getElementById('nl-description').value = data.description || '';
//         showToast('📤', 'Shared content ready — add details and post!');
//       }
//     } catch (e) {}
//   }
// });
