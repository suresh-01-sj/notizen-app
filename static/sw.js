// Service Worker for Notizen PWA
const CACHE_NAME = 'notizen-v5.8';
const ASSETS_TO_CACHE = [
    '/',
    '/index.html',
    '/manifest.json',
    '/css/style.css',
    '/js/app.js',
    '/images/notizen_logo.webp',
    '/images/icon-192.png',
    '/images/icon-512.png',
    '/static/css/style.css',
    '/static/js/app.js',
    '/static/images/notizen_logo.webp',
    '/static/images/icon-192.png',
    '/static/images/icon-512.png'
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS_TO_CACHE).catch(err => console.warn('PWA caching partial:', err));
        })
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    // Only handle GET requests; bypass API and WebSockets
    if (event.request.method !== 'GET' || event.request.url.includes('/api/') || event.request.url.includes('/ws')) {
        return;
    }
    // Network first for CSS & JS to ensure immediate updates, fallback to cache
    if (event.request.url.includes('/css/') || event.request.url.includes('/js/')) {
        event.respondWith(
            fetch(event.request)
                .then((response) => {
                    if (response && response.status === 200) {
                        const copy = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
                    }
                    return response;
                })
                .catch(() => caches.match(event.request))
        );
        return;
    }
    // Cache first for other assets (images, icons, html)
    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            return cachedResponse || fetch(event.request);
        })
    );
});
