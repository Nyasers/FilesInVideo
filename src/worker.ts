/**
 * FilesInVideo Web Worker — 编码引擎
 * 接收编码任务，执行 prepareEncode + buildStream，
 * 通过 postMessage 回报进度和 chunk 数据。
 */

import { prepareEncode, buildStream } from './lib/encoder';
import type { FileEntry } from './lib/types';

let cancelFlag = false;

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data;
  if (!msg?.type) return;

  if (msg.type === 'encode') {
    cancelFlag = false;
    try {
      const { coverVideo, files, password } = msg;

      const fileEntries: FileEntry[] = files.map((f: File) => ({
        name: f.name, size: f.size, data: f,
      }));

      // 1. 准备阶段（解析封面、密钥派生、预计算）
      const prep = await prepareEncode({
        coverVideo,
        files: fileEntries,
        password,
        onProgress: (phase, pct) => {
          self.postMessage({ type: 'progress', phase, pct });
        },
      });

      if (cancelFlag) throw new Error('已取消');

      // 2. 流式编码，逐 chunk 投递
      const total = prep.headerBlob.size + prep.mdatTotalSize;
      const stream = buildStream(prep, fileEntries);
      const reader = stream.getReader();
      let written = 0;

      while (true) {
        if (cancelFlag) throw new Error('已取消');
        const { done, value } = await reader.read();
        if (done) break;
        written += value!.length;
        self.postMessage({
          type: 'progress',
          phase: '编码中',
          pct: 30 + Math.round((written / total) * 70),
        });
        // 复制一份独立 buffer 再投递，避免共享 ArrayBuffer 被 GC 干扰
        const copy = new Uint8Array(value!);
        self.postMessage({ type: 'chunk', data: copy.buffer }, [copy.buffer]);
      }

      if (cancelFlag) throw new Error('已取消');

      self.postMessage({
        type: 'done',
        fileCount: prep.fileCount,
        totalDataSize: prep.fileTotalData,
        audioFrames: prep.totalAudioFrames,
      });
    } catch (e: any) {
      self.postMessage({ type: 'error', error: e.message || String(e) });
    }
  } else if (msg.type === 'cancel') {
    cancelFlag = true;
  }
};
