/**
 * FilesInVideo 编码器
 * prepareEncode: 快速准备（解析封面、密钥派生、预计算元数据）
 * buildStream: 懒构建 ReadableStream（在消费时才读取文件数据）
 * encode: 便捷组合函数
 */

import { BoxBuilder } from './isobmff/box';
import { createEncMagic, deriveKey } from './crypto/pbkdf2';
import { AesCtrStream } from './crypto/aes-ctr';
import { parseCoverMp4 } from './cover-parser';
import {
  FileEntry, CoverInfo, EncodeOptions, EncodeResult, PrepareResult,
  FIV1_MAGIC, FRAME0_HEADER_SIZE, PBKDF2_ITERATIONS,
  SOWT_SAMPLE_RATE, SOWT_CHANNELS, SOWT_BITS,
} from './types';

/** 准备阶段：解析封面 + 密钥派生 + 预计算。 */
export async function prepareEncode(options: EncodeOptions): Promise<PrepareResult> {
  const { coverVideo, files, password, onProgress } = options;
  const p = (phase: string, pct: number) => onProgress?.(phase, pct);

  p('解析封面', 0);
  const cover = await parseCoverMp4(coverVideo);
  p('解析封面', 8);
  const enc = new TextEncoder();
  const fileListSize = files.reduce((s, f) => s + 2 + 8 + enc.encode(f.name).length, 0);
  const fileTotalData = files.reduce((s, f) => s + f.size, 0);
  const frame0EncData = 8 + fileListSize;
  const sample0Size = FRAME0_HEADER_SIZE + frame0EncData;
  const targetFrames = Math.max(1, cover.duration);
  const adaptiveBps = Math.max(sample0Size, Math.ceil(fileTotalData / targetFrames));

  const dataFiles = files.filter(f => f.size > 0);
  const audioSizes: number[] = [];
  for (const file of dataFiles) {
    let r = file.size;
    while (r > 0) { const sz = Math.min(r, adaptiveBps); audioSizes.push(sz); r -= sz; }
  }
  const preData = fileTotalData > 0 ? Math.ceil(fileTotalData / adaptiveBps) : 0;
  while (audioSizes.length < preData) audioSizes.push(0);
  const totalAudioFrames = 1 + audioSizes.length;

  p('派生密钥', 10);
  const frameSalt = crypto.getRandomValues(new Uint8Array(16));
  const { key } = await deriveKey(password, frameSalt, PBKDF2_ITERATIONS);
  const encMagic = await createEncMagic(key, frameSalt);
  p('派生密钥', 14);

  const fileListBuf = new Uint8Array(fileListSize);
  let flOff = 0;
  for (const file of files) {
    const nb = enc.encode(file.name);
    new DataView(fileListBuf.buffer).setUint16(flOff, nb.length, false);
    new DataView(fileListBuf.buffer).setBigUint64(flOff + 2, BigInt(file.size), false);
    flOff += 10; fileListBuf.set(nb, flOff); flOff += nb.length;
  }

  const sample0Header = new Uint8Array(FRAME0_HEADER_SIZE);
  new DataView(sample0Header.buffer).setUint32(0, FIV1_MAGIC, false);
  sample0Header.set(encMagic, 4); sample0Header.set(frameSalt, 8);
  new DataView(sample0Header.buffer).setUint32(24, PBKDF2_ITERATIONS, false);

  const frame0Plain = new Uint8Array(frame0EncData);
  new DataView(frame0Plain.buffer).setBigUint64(0, BigInt(files.length), false);
  frame0Plain.set(fileListBuf, 8);

  const ctr0 = new AesCtrStream(key, 1);
  p('加密索引', 16);
  const frame0Encrypted = await ctr0.encrypt(frame0Plain);
  const sample0Data = new Uint8Array(sample0Size);
  sample0Data.set(sample0Header, 0);
  sample0Data.set(frame0Encrypted, FRAME0_HEADER_SIZE);
  p('加密索引', 20);

  const vidDuration = cover.duration;
  const audDuration = totalAudioFrames;
  const vidDataSize = cover.frames.reduce((s, f) => s + f.size, 0);
  const audioDataSize = sample0Size + audioSizes.reduce((s, x) => s + x, 0);
  const mdatTotalSize = 8 + vidDataSize + audioDataSize;

  // 两遍构建 moov：第一遍测 header 大小，第二遍用已知大小填正确的 co64 绝对偏移
  const hParams = { cover, totalAudioFrames, audDuration, vidDuration, vidDataSize, sample0Size, audioSizes };
  const headerSize = buildHeaderBlob(hParams).size;
  const headerBlob = buildHeaderBlob(hParams, headerSize);
  p('构建容器', 28);

  return {
    cover, key, sample0Data, sample0Size, audioSizes,
    totalAudioFrames, audDuration, vidDuration, vidDataSize,
    audioDataSize, fileTotalData, fileCount: files.length,
    headerBlob, mdatTotalSize,
  };
}

/** 懒构建 ReadableStream：pull 模式，消费者拉取时才产出数据 */
export function buildStream(
  prep: PrepareResult,
  files: FileEntry[],
  skipHeader = false,
): ReadableStream<Uint8Array> {
  const { cover, key, sample0Data, sample0Size, audioSizes, mdatTotalSize } = prep;
  const sizes = [...audioSizes];

  // 预构建静态数据队列
  const chunks: Uint8Array[] = [];
  let done = false;
  let error: Error | null = null;
  let resolvePull: (() => void) | null = null;

  // 异步处理器：填充 chunks 队列
  async function producer(controller: ReadableStreamDefaultController<Uint8Array>) {
    try {
      // header（允许跳过，用于 seek-to-end 模式）
      if (!skipHeader) {
        const headerBuf = new Uint8Array(await prep.headerBlob.arrayBuffer());
        push(controller, headerBuf);
      }
      push(controller, buildMdatHeader(mdatTotalSize));

      // 视频数据：整块复制（避免逐帧切片偏移计算错误）
      const videoStart = cover.frames[0].offset - cover.mdatStart;
      push(controller, cover.mdatData.slice(videoStart, videoStart + prep.vidDataSize));

      // 帧 0
      push(controller, sample0Data);

      // 流式加密文件数据
      const frame0EncDataSize = sample0Size - FRAME0_HEADER_SIZE;
      const ctr = new AesCtrStream(key, 1);
      await ctr.encrypt(new Uint8Array(frame0EncDataSize));

      const dataFiles = files.filter(f => f.size > 0);
      for (const file of dataFiles) {
        const reader = (file.data as Blob).stream().getReader();
        const br = new BufferedReader(reader);
        let remaining = file.size;
        while (remaining > 0) {
          const need = sizes.shift()!;
          if (need === 0) { remaining = 0; continue; }
          let chunk = await br.readExactly(need);
          if (chunk.length < need) {
            const p = new Uint8Array(need);
            if (chunk.length > 0) p.set(chunk, 0);
            chunk = p;
          }
          push(controller, await ctr.encrypt(chunk));
          remaining -= need;
        }
      }

      // 标记完成
      done = true;
      if (resolvePull) resolvePull();
    } catch (e: any) {
      error = e;
      done = true;
      if (resolvePull) resolvePull();
    }
  }

  function push(_controller: ReadableStreamDefaultController<Uint8Array>, chunk: Uint8Array) {
    chunks.push(chunk);
    // 唤醒等待中的 pull，避免 producer 直接 enqueue 打乱顺序
    if (resolvePull) { const cb = resolvePull; resolvePull = null; cb(); }
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      producer(controller); // fire-and-forget
    },
    pull(controller) {
      // 先清空积压队列
      while (chunks.length > 0 && controller.desiredSize! > 0) {
        controller.enqueue(chunks.shift()!);
      }
      if (done) {
        // queue 没排空前不能 close：producer 可能已结束但积压未消费完
        if (chunks.length === 0) {
          if (error) controller.error(error);
          else controller.close();
        }
        return;
      }
      // 等待 producer 填入更多数据
      return new Promise<void>((resolve) => {
        resolvePull = () => {
          resolvePull = null;
          // 填入后再次清空
          while (chunks.length > 0 && controller.desiredSize! > 0) {
            controller.enqueue(chunks.shift()!);
          }
          if (done && chunks.length === 0) {
            if (error) controller.error(error);
            else controller.close();
          }
          resolve();
        };
      });
    },
  });
}

/** 便捷组合：prepare + buildStream + 返回完整结果 */
export async function encode(options: EncodeOptions): Promise<EncodeResult> {
  const prep = await prepareEncode(options);
  const stream = buildStream(prep, options.files);
  return {
    stream,
    fileCount: prep.fileCount,
    totalDataSize: prep.fileTotalData,
    audioFrames: prep.totalAudioFrames,
    videoDuration: prep.vidDuration,
  };
}

// ── helpers ──

class BufferedReader {
  private buf = new Uint8Array(0);
  private done = false;
  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}
  async readExactly(n: number): Promise<Uint8Array> {
    while (this.buf.length < n && !this.done) {
      const { done, value } = await this.reader.read();
      if (done) { this.done = true; break; }
      if (!value) continue;
      const m = new Uint8Array(this.buf.length + value.length);
      m.set(this.buf, 0); m.set(value, this.buf.length); this.buf = m;
    }
    const take = Math.min(n, this.buf.length);
    const r = this.buf.slice(0, take);
    this.buf = this.buf.slice(take);
    return r;
  }
}

function buildMdatHeader(totalSize: number): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setUint32(0, totalSize, false);
  buf.set(new TextEncoder().encode('mdat'), 4);
  return buf;
}

// ── moov 构建 ──

interface HParams {
  cover: CoverInfo;
  totalAudioFrames: number; audDuration: number; vidDuration: number;
  vidDataSize: number; sample0Size: number; audioSizes: number[];
}

function buildHeaderBlob(p: HParams, headerSize?: number): Blob {
  const b = new BoxBuilder();
  buildFtyp(b);
  buildMoov(b, p, headerSize);
  return b.buildBlob();
}

function buildFtyp(b: BoxBuilder) {
  b.startBox('ftyp');
  b.writeFourCC('mp42'); b.writeU32(0);
  b.writeFourCC('mp42'); b.writeFourCC('mp41');
  b.writeFourCC('isom'); b.writeFourCC('avc1');
  b.endBox();
}

function buildMoov(b: BoxBuilder, p: HParams, headerSize?: number) {
  b.startBox('moov');
  buildMvhd(b, p);
  buildVideoTrak(b, p, headerSize);
  buildAudioTrak(b, p, headerSize);
  b.endBox();
}

function buildMvhd(b: BoxBuilder, p: HParams) {
  b.startBox('mvhd'); b.writeVersion(0);
  b.writeU32(0); b.writeU32(0); b.writeU32(p.cover.timescale); b.writeU32(p.vidDuration);
  b.writeU32(0x10000); b.writeU16(0x100); b.writeFixed(10, 0);
  b.writeU32(0x00010000); b.writeU32(0); b.writeU32(0);
  b.writeU32(0); b.writeU32(0x00010000); b.writeU32(0);
  b.writeU32(0); b.writeU32(0); b.writeU32(0x40000000);
  b.writeFixed(24, 0); b.writeU32(2); b.endBox();
}

function buildVideoTrak(b: BoxBuilder, p: HParams, headerSize?: number) {
  b.startBox('trak');
  b.startBox('tkhd'); b.writeVersion(0, 7);
  b.writeU32(0); b.writeU32(0); b.writeU32(1); b.writeU32(0);
  b.writeU32(p.vidDuration); b.writeFixed(8, 0);
  b.writeU16(0); b.writeU16(0); b.writeU16(0x100); b.writeFixed(2, 0);
  b.writeU32(0x00010000); b.writeU32(0); b.writeU32(0);
  b.writeU32(0); b.writeU32(0x00010000); b.writeU32(0);
  b.writeU32(0); b.writeU32(0); b.writeU32(0x40000000);
  b.writeU32(p.cover.width << 16); b.writeU32(p.cover.height << 16); b.endBox();

  b.startBox('mdia');
  b.startBox('mdhd'); b.writeVersion(0); b.writeU32(0); b.writeU32(0);
  b.writeU32(p.cover.timescale); b.writeU32(p.cover.duration);
  b.writeU16(0x55c4); b.writeU16(0); b.endBox();
  b.startBox('hdlr'); b.writeVersion(0); b.writeFixed(4, 0);
  b.writeFourCC('vide'); b.writeFixed(12, 0);
  b.write(new TextEncoder().encode('VideoHandler\0')); b.endBox();

  b.startBox('minf');
  b.startBox('vmhd'); b.writeVersion(0, 1); b.writeU16(0);
  b.writeU16(0); b.writeU16(0); b.writeU16(0); b.endBox();
  b.startBox('dinf');
  b.startBox('dref'); b.writeVersion(0); b.writeU32(1);
  b.writeU32(0x0c); b.writeFourCC('url '); b.writeVersion(0, 1); b.endBox();
  b.endBox();

  buildVideoStbl(b, p, headerSize);
  b.endBox(); // minf
  b.endBox(); // mdia
  b.endBox(); // trak
}

function buildVideoStbl(b: BoxBuilder, p: HParams, headerSize?: number) {
  b.startBox('stbl');
  b.startBox('stsd'); b.write(p.cover.stsdData); b.endBox();
  b.startBox('stts'); b.write(p.cover.stts); b.endBox();
  b.startBox('stss'); b.write(p.cover.stss); b.endBox();
  if (p.cover.sdtp) { b.startBox('sdtp'); b.write(p.cover.sdtp); b.endBox(); }
  b.startBox('stsc'); b.writeVersion(0); b.writeU32(1);
  b.writeU32(1); b.writeU32(p.cover.frames.length); b.writeU32(1); b.endBox();
  b.startBox('stsz'); b.write(p.cover.stsz); b.endBox();
  // co64: 视频数据从 headerSize + 8（跳过 mdat 头）开始
  const vOff = headerSize != null ? BigInt(headerSize + 8) : 0n;
  b.startBox('co64'); b.writeVersion(0); b.writeU32(1); b.writeU64(vOff); b.endBox();
  if (p.cover.ctts) { b.startBox('ctts'); b.write(p.cover.ctts); b.endBox(); }
  b.endBox();
}

function buildAudioTrak(b: BoxBuilder, p: HParams, headerSize?: number) {
  b.startBox('trak');
  b.startBox('tkhd'); b.writeVersion(0, 7);
  b.writeU32(0); b.writeU32(0); b.writeU32(2); b.writeU32(0);
  b.writeU32(p.audDuration); b.writeFixed(8, 0);
  b.writeU16(0); b.writeU16(0); b.writeU16(0x100); b.writeFixed(2, 0);
  b.writeU32(0x00010000); b.writeU32(0); b.writeU32(0);
  b.writeU32(0); b.writeU32(0x00010000); b.writeU32(0);
  b.writeU32(0); b.writeU32(0); b.writeU32(0x40000000);
  b.writeU32(0); b.writeU32(0); b.endBox();

  b.startBox('mdia');
  b.startBox('mdhd'); b.writeVersion(0); b.writeU32(0); b.writeU32(0);
  b.writeU32(p.cover.timescale); b.writeU32(p.audDuration);
  b.writeU16(0x55c4); b.writeU16(0); b.endBox();
  b.startBox('hdlr'); b.writeVersion(0); b.writeFixed(4, 0);
  b.writeFourCC('soun'); b.writeFixed(12, 0);
  b.write(new TextEncoder().encode('SoundHandler\0')); b.endBox();

  b.startBox('minf');
  b.startBox('smhd'); b.writeVersion(0); b.writeU16(0); b.writeU16(0); b.endBox();
  b.startBox('dinf');
  b.startBox('dref'); b.writeVersion(0); b.writeU32(1);
  b.writeU32(0x0c); b.writeFourCC('url '); b.writeVersion(0, 1); b.endBox();
  b.endBox();

  b.startBox('stbl');
  b.startBox('stsd'); b.writeVersion(0); b.writeU32(1); buildSowtEntry(b); b.endBox();
  b.startBox('stts'); b.writeVersion(0); b.writeU32(1);
  b.writeU32(p.totalAudioFrames); b.writeU32(1); b.endBox();
  b.startBox('stsc'); b.writeVersion(0); b.writeU32(1);
  b.writeU32(1); b.writeU32(p.totalAudioFrames); b.writeU32(1); b.endBox();
  b.startBox('stsz'); b.writeVersion(0); b.writeU32(0);
  b.writeU32(1 + p.audioSizes.length); b.writeU32(p.sample0Size);
  for (const sz of p.audioSizes) b.writeU32(sz);
  b.endBox();
  // co64: 音频数据从 headerSize + 8 + vidDataSize（视频数据之后）开始
  const aOff = headerSize != null ? BigInt(headerSize + 8 + p.vidDataSize) : BigInt(p.vidDataSize);
  b.startBox('co64'); b.writeVersion(0); b.writeU32(1);
  b.writeU64(aOff); b.endBox();
  b.endBox(); // stbl
  b.endBox(); // minf
  b.endBox(); // mdia
  b.endBox(); // trak
}

function buildSowtEntry(b: BoxBuilder) {
  b.writeU32(54); b.writeFourCC('sowt'); b.writeFixed(6, 0); b.writeU16(1);
  b.writeU16(0); b.writeU16(0); b.writeU32(0);
  b.writeU16(SOWT_CHANNELS); b.writeU16(SOWT_BITS);
  b.writeU16(0); b.writeU16(0); b.writeU32(SOWT_SAMPLE_RATE << 16);
  b.startBox('wave');
  b.startBox('enda'); b.writeU16(1); b.endBox();
  b.endBox();
}
