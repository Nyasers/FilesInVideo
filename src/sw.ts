/**
 * FilesInVideo Service Worker — 生命周期 + 缓存（编码已迁移至 Web Worker）
 */
console.log('[SW] loaded');

self.addEventListener('install', () => (self as any).skipWaiting());
self.addEventListener('activate', (e: any) => e.waitUntil(self.clients.claim()));
