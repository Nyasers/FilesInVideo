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

      // 2. 提取 header，主线程 seek 到 headerSize 后再写 mdat
      const headerBuf = new Uint8Array(await prep.headerBlob.arrayBuffer());
      const headerSize = headerBuf.byteLength;
      self.postMessage({ type: 'enc-size', total: headerSize + prep.mdatTotalSize });
      self.postMessage({ type: 'header-size', size: headerSize });

      // 流式构建 mdat（跳过 header）
      const stream = buildStream(prep, fileEntries, true);
      const reader = stream.getReader();
      let written = 0;

      while (true) {
        if (cancelFlag) throw new Error('已取消');
        const { done, value } = await reader.read();
        if (done) break;
        written += value!.length;
        self.postMessage({ type: 'enc-progress', pct: Math.round((written / prep.mdatTotalSize) * 100) });
        const copy = new Uint8Array(value!);
            self.postMessage({ type: 'chunk', data: copy.buffer, size: copy.length }, [copy.buffer]);
      }

      if (cancelFlag) throw new Error('已取消');

      // 最后 seek 回位置 0 写入 header
      self.postMessage({ type: 'chunk', data: headerBuf.buffer, size: headerBuf.length, pos: 0 }, [headerBuf.buffer]);

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
