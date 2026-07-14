/**
 * FilesInVideo 流式解码器
 *
 * 只读 moov 元数据（几 KB），音频 sample 按 1MB 批次 blob.slice() 读取。
 * 内存峰值 ≈ 最大 sample 大小 + 1MB 批次缓冲。
 */

import { BoxReader } from './isobmff/reader';
import { verifyEncMagic, deriveKey } from './crypto/pbkdf2';
import { AesCtrStream } from './crypto/aes-ctr';
import {
  DecodeOptions, DecodeResult, DecodedFile,
  FIV1_MAGIC, FRAME0_HEADER_SIZE,
} from './types';

const BATCH = 1024 * 1024; // 1MB 批次

export async function decode(options: DecodeOptions): Promise<DecodeResult> {
  const { blob, password, onProgress } = options;
  const p = (phase: string, pct: number) => onProgress?.(phase, pct);

  // ── 1. 只读 moov 头部 ──
  p('读取文件', 0);
  const headSize = Math.min(blob.size, 2 * 1024 * 1024);
  let headBuf = new Uint8Array(await blob.slice(0, headSize).arrayBuffer());

  // 找 moov（我们的编码 ftyp + moov 总在开头）
  let reader = new BoxReader(headBuf);
  let topBoxes = reader.parseTopLevel();
  let moov = reader.findBox(topBoxes, 'moov');

  // 如果 moov 超出首段，补读
  if (!moov || !moov.children) {
    const moovEnd = topBoxes.find(b => b.type === 'moov') ? 0 : 0;
    if (moovEnd > headSize) {
      headBuf = new Uint8Array(await blob.slice(0, moovEnd).arrayBuffer());
      reader = new BoxReader(headBuf);
      topBoxes = reader.parseTopLevel();
      moov = reader.findBox(topBoxes, 'moov');
    }
  }
  if (!moov || !moov.children) throw new Error('缺少 moov box');

  // ── 2. 解析音频轨元数据 ──
  const sounTrak = reader.findTrak(moov.children, 'soun');
  if (!sounTrak?.children) throw new Error('缺少音频轨');

  const sMdia = reader.findBox(sounTrak.children, 'mdia');
  const sMinf = sMdia?.children ? reader.findBox(sMdia.children, 'minf') : null;
  const sStbl = sMinf?.children ? reader.findBox(sMinf.children, 'stbl') : null;
  if (!sStbl?.children) throw new Error('音频轨缺少 stbl');

  const sStsz = reader.findBox(sStbl.children, 'stsz');
  if (!sStsz) throw new Error('音频轨缺少 stsz');

  const coBox = reader.findBox(sStbl.children, 'co64') || reader.findBox(sStbl.children, 'stco');
  if (!coBox) throw new Error('音频轨缺少 co64/stco');

  p('解析音频帧表', 5);
  const stszDV = new DataView(sStsz.data.buffer, sStsz.data.byteOffset, sStsz.data.length);
  if (stszDV.getUint32(4, false) !== 0) throw new Error('非 FIV 格式');

  const sampleCount = stszDV.getUint32(8, false);
  if (sampleCount < 1) throw new Error('音频轨无 sample');

  const sampleSizes: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    sampleSizes.push(stszDV.getUint32(12 + i * 4, false));
  }

  // co64/stco → 第一个音频 chunk 的绝对偏移
  const coDV = new DataView(coBox.data.buffer, coBox.data.byteOffset, coBox.data.length);
  const audioBaseOffset = coBox.type === 'co64'
    ? Number(coDV.getBigUint64(8, false))
    : coDV.getUint32(8, false);

  // ── 3. 读取帧 0 ──
  p('读取帧 0', 10);
  const sample0Size = sampleSizes[0];
  const sample0Buf = new Uint8Array(await blob.slice(audioBaseOffset, audioBaseOffset + sample0Size).arrayBuffer());

  const magic = new DataView(sample0Buf.buffer, sample0Buf.byteOffset, 4).getUint32(0, false);
  if (magic !== FIV1_MAGIC) throw new Error('不是有效的 FIV 文件');

  const encMagic = sample0Buf.slice(4, 8);
  const frameSalt = sample0Buf.slice(8, 24);
  const iter = new DataView(sample0Buf.buffer, sample0Buf.byteOffset + 24, 4).getUint32(0, false);

  p('验证密码', 15);
  const { key } = await deriveKey(password, frameSalt, iter);
  if (!await verifyEncMagic(key, encMagic)) throw new Error('密码错误');

  p('解密文件索引', 20);
  const frame0EncData = sample0Buf.slice(FRAME0_HEADER_SIZE);
  const ctr = new AesCtrStream(key, 1);
  const frame0Decrypted = await ctr.decrypt(frame0EncData);

  const f0DV = new DataView(frame0Decrypted.buffer, frame0Decrypted.byteOffset, frame0Decrypted.length);
  const fileCount = Number(f0DV.getBigUint64(0, false));

  const dec = new TextDecoder();
  const entries: { name: string; size: number }[] = [];
  let eOff = 8;
  for (let i = 0; i < fileCount; i++) {
    const nameLen = f0DV.getUint16(eOff, false);
    const dataLen = Number(f0DV.getBigUint64(eOff + 2, false));
    const name = dec.decode(frame0Decrypted.slice(eOff + 10, eOff + 10 + nameLen));
    entries.push({ name, size: dataLen });
    eOff += 10 + nameLen;
  }

  // ── 4. 计算 sample 偏移表 ──
  p('计算数据偏移', 25);
  const sampleOffsets: number[] = [];
  let off = audioBaseOffset;
  for (let i = 0; i < sampleCount; i++) {
    sampleOffsets.push(off);
    off += sampleSizes[i];
  }

  // ── 5. 批次读取 + 逐个 sample 解密 ──
  const files: DecodedFile[] = [];
  let totalRead = 0;
  const totalDataSize = entries.reduce((s, e) => s + e.size, 0);

  let sampleIdx = 1;
  let batchStart = sampleOffsets[1]; // sample 1 起始
  let batchBuf: Uint8Array | null = null;

  for (const entry of entries) {
    const decryptedChunks: Uint8Array[] = [];
    let remaining = entry.size;

    while (remaining > 0 && sampleIdx < sampleCount) {
      const sampleSize = sampleSizes[sampleIdx];
      const sampleStart = sampleOffsets[sampleIdx];

      // 确保当前 sample 在批次缓冲内
      if (!batchBuf || sampleStart + sampleSize > batchStart + batchBuf.length) {
        const readSize = Math.min(BATCH, blob.size - sampleStart);
        batchBuf = new Uint8Array(await blob.slice(sampleStart, sampleStart + readSize).arrayBuffer());
        batchStart = sampleStart;
      }

      const relOff = sampleStart - batchStart;
      const encSample = batchBuf.slice(relOff, relOff + sampleSize);
      const decSample = await ctr.decrypt(encSample);
      sampleIdx++;

      const take = Math.min(remaining, sampleSize);
      decryptedChunks.push(decSample.slice(0, take));
      remaining -= take;
      totalRead += take;

      const pct = 30 + Math.floor((totalRead / totalDataSize) * 65);
      if (totalRead % (2 * 1024 * 1024) < 10000) {
        p('解密文件数据', pct);
      }
    }

    const totalLen = decryptedChunks.reduce((s, c) => s + c.length, 0);
    const result = new Uint8Array(totalLen);
    let co = 0;
    for (const c of decryptedChunks) { result.set(c, co); co += c.length; }

    files.push({
      name: entry.name,
      size: entry.size,
      blob: new Blob([result.slice(0, entry.size)]),
    });
  }

  p('完成', 100);
  return { files };
}
