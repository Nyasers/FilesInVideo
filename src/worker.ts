/**
 * FilesInVideo Web Worker — 编码 / 解码引擎
 */

import { prepareEncode, buildStream } from './lib/encoder';
import { decode } from './lib/decoder';
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
          self.postMessage({ type: 'prep-progress', phase, pct: Math.round(pct / 28 * 100) });
        },
      });

      if (cancelFlag) throw new Error('已取消');

      // 2. 流式编码，逐 chunk 投递
      const total = prep.headerBlob.size + prep.mdatTotalSize;
      self.postMessage({ type: 'enc-size', total });
      const stream = buildStream(prep, fileEntries);
      const reader = stream.getReader();
      let written = 0;

      while (true) {
        if (cancelFlag) throw new Error('已取消');
        const { done, value } = await reader.read();
        if (done) break;
        written += value!.length;
        self.postMessage({ type: 'enc-progress', pct: Math.round((written / total) * 100) });
        const copy = new Uint8Array(value!);
            self.postMessage({ type: 'chunk', data: copy.buffer, size: copy.length }, [copy.buffer]);
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
  } else if (msg.type === 'decode') {
    cancelFlag = false;
    try {
      const { blob, password } = msg;

      const result = await decode({
        blob,
        password,
        onProgress: (phase, pct) => {
          if (cancelFlag) throw new Error('已取消');
          self.postMessage({ type: 'dec-progress', phase, pct });
        },
      });

      if (cancelFlag) throw new Error('已取消');

      for (const file of result.files) {
        self.postMessage({ type: 'dec-file-start', name: file.name, size: file.size });
        const buf = new Uint8Array(await file.blob.arrayBuffer());
        self.postMessage(
          { type: 'dec-file', name: file.name, size: file.size, data: buf.buffer },
          [buf.buffer],
        );
      }

      self.postMessage({ type: 'dec-done' });
    } catch (e: any) {
      self.postMessage({ type: 'dec-error', error: e.message || String(e) });
    }
  } else if (msg.type === 'cancel') {
    cancelFlag = true;
  }
};
