/**
 * FilesInVideo Service Worker — 解码 + 流式下载
 * 架构对齐 F2P：主线程触发 iframe，SW 拦截 fetch 直接流式投递解密数据
 */

import { decode } from './lib/decoder';

console.log('[SW] loaded');

interface Job {
  files: { name: string; size: number; blob: Blob }[];
}

const jobs = new Map<string, Job>();

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg?.type) return;
  if (msg.type === 'decode') {
    event.waitUntil(runDecode(event, msg));
  }
});

async function runDecode(event: ExtendableMessageEvent, msg: { jobId: string; blob: Blob; password: string }) {
  const { jobId, blob, password } = msg;
  const source = event.source as Client | null;

  try {
    const result = await decode({
      blob,
      password,
      onProgress: (phase, pct) => {
        postAll({ type: 'dec-progress', jobId, phase, pct });
      },
    });

    jobs.set(jobId, {
      files: result.files.map(f => ({ name: f.name, size: f.size, blob: f.blob })),
    });

    if (source) {
      source.postMessage({
        type: 'decode-ready',
        jobId,
        files: result.files.map(f => ({ name: f.name, size: f.size })),
      });
    }
  } catch (e: any) {
    if (source) source.postMessage({ type: 'decode-error', jobId, error: e.message || String(e) });
  }
}

// ── 流式下载拦截 ──

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname === '/fiv-extract' && event.request.method === 'GET') {
    event.respondWith(serveExtract(url));
  }
});

async function serveExtract(url: URL): Promise<Response> {
  const jobId = url.searchParams.get('id');
  const idx = parseInt(url.searchParams.get('idx') || '0');
  if (!jobId) return new Response('Missing id', { status: 400 });

  const job = jobs.get(jobId);
  if (!job || !job.files[idx]) return new Response('Not found', { status: 404 });

  const file = job.files[idx];
  return new Response(file.blob.stream(), {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'Content-Length': String(file.size),
    },
  });
}

function postAll(msg: Record<string, unknown>) {
  self.clients.matchAll().then(cs => { for (const c of cs) c.postMessage(msg); });
}

self.addEventListener('install', () => (self as any).skipWaiting());
self.addEventListener('activate', (e: any) => e.waitUntil(self.clients.claim()));
