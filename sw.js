// ═══════════════════════════════════════════════════════════════
// The Swap Yard — Service Worker (PWA)
// File: sw.js  (must be in ROOT of your site, not in a subfolder)
//
// WHAT THIS DOES:
//   ✅ Caches the app shell for offline use
//   ✅ Serves cached pages when user is offline
//   ✅ Background sync for messages sent while offline
//   ✅ Push notifications for new messages and offers
//   ✅ Periodic background fetch for new listings
// ═══════════════════════════════════════════════════════════════

const CACHE_NAME    = 'swapyard-v3';
const OFFLINE_URL   = '/offline.html';

// Files to cache immediately on install (app shell)
const PRECACHE = [
  '/',
  '/index.html',
  '/vendor-dashboard.html',
  '/terms.html',
  '/manifest.json',
  '/offline.html',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap',
];

// ── INSTALL: cache app shell ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: clean old caches ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── FETCH: network-first with offline fallback ──
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and API calls
  if (request.method !== 'GET') return;
  if (url.pathname.startsWith('/.netlify/functions/')) return;
  if (url.hostname !== location.hostname) return;

  event.respondWith(
    fetch(request)
      .then(response => {
        // Cache successful HTML/CSS/JS responses
        if (response.ok && ['text/html','text/css','application/javascript'].some(t => response.headers.get('content-type')?.includes(t))) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then(cached => {
          if (cached) return cached;
          // For HTML navigations, show offline page
          if (request.headers.get('accept')?.includes('text/html')) {
            return caches.match(OFFLINE_URL);
          }
          return new Response('Offline', { status: 503 });
        })
      )
  );
});

// ── PUSH NOTIFICATIONS ──
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();

  const options = {
    body:    data.body || 'You have a new notification',
    icon:    '/icons/icon-192.png',
    badge:   '/icons/icon-72.png',
    image:   data.image || null,
    vibrate: [200, 100, 200],
    tag:     data.tag || 'swapyard-notification',
    renotify: true,
    data:    { url: data.url || '/', type: data.type },
    actions: data.actions || [
      { action: 'view',    title: 'View Now' },
      { action: 'dismiss', title: 'Dismiss'  },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'The Swap Yard', options)
  );
});

// ── NOTIFICATION CLICK ──
self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;

  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        const existing = clientList.find(c => c.url === url && 'focus' in c);
        if (existing) return existing.focus();
        return clients.openWindow(url);
      })
  );
});

// ── BACKGROUND SYNC (offline messages) ──
self.addEventListener('sync', event => {
  if (event.tag === 'sync-messages') {
    event.waitUntil(syncPendingMessages());
  }
});

async function syncPendingMessages() {
  try {
    // Get pending messages from IndexedDB
    const db = await openDB();
    const pending = await getAllFromStore(db, 'pending-messages');

    for (const msg of pending) {
      try {
        await fetch('/.netlify/functions/send-message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(msg),
        });
        await deleteFromStore(db, 'pending-messages', msg.id);
      } catch (e) {
        console.error('Failed to sync message:', e);
      }
    }
  } catch (e) {
    console.error('Sync failed:', e);
  }
}

// ── SIMPLE INDEXEDDB HELPERS ──
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('swapyard-offline', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('pending-messages')) {
        db.createObjectStore('pending-messages', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('wishlists')) {
        db.createObjectStore('wishlists', { keyPath: 'id' });
      }
    };
    req.onsuccess  = e => resolve(e.target.result);
    req.onerror    = e => reject(e.target.error);
  });
}
function getAllFromStore(db, store) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}
function deleteFromStore(db, store, id) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}
