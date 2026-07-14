/** SW 客户端工具 */

let swCtrl: ServiceWorker | null = null;

export async function registerSw(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js');
    swCtrl = (await navigator.serviceWorker.ready).active;
  } catch (e) { console.warn('SW register failed:', e); }
}

export async function waitForSw(): Promise<void> {
  if (swCtrl) return;
  await navigator.serviceWorker.ready;
  swCtrl = navigator.serviceWorker.controller;
}

export function sendToSw(msg: Record<string, unknown>): void {
  if (swCtrl) swCtrl.postMessage(msg);
}

/** 触发 iframe 下载（浏览器原生下载管理器接管，Blob 走 stream 不滞留内存） */
export function triggerDownload(path: string): void {
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  iframe.src = path;
  document.body.appendChild(iframe);
  setTimeout(() => { if (iframe.parentNode) iframe.remove(); }, 60000);
}
