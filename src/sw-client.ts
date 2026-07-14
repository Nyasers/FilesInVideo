/** Service Worker 注册（PWA 基础） */
export async function registerSw(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
  } catch (e) {
    console.warn('SW register failed:', e);
  }
}
