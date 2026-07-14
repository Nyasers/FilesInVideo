/**
 * FilesInVideo 解码器
 *
 * 从双轨 MP4 中提取加密文件数据并解密
 */

import { BoxReader } from './isobmff/reader';
import { verifyEncMagic, deriveKey } from './crypto/pbkdf2';
import { AesCtrStream } from './crypto/aes-ctr';
import {
  DecodeOptions, DecodeResult, DecodedFile,
  FIV1_MAGIC, FRAME0_HEADER_SIZE, AES_BLOCK,
} from './types';

export async function decode(options: DecodeOptions): Promise<DecodeResult> {
  const { blob, password, onProgress } = options;

  // 1. 读取文件
  onProgress?.('读取文件', 0);
  const buf = new Uint8Array(await blob.arrayBuffer());
  const reader = new BoxReader(buf);

  const topBoxes = reader.parseTopLevel();

  // 验证 ftyp
  const ftyp = reader.findBox(topBoxes, 'ftyp');
  if (!ftyp) throw new Error('不是有效的 MP4 文件');

  // 找 moov → trak(soun) → stbl
  const moov = reader.findBox(topBoxes, 'moov');
  if (!moov || !moov.children) throw new Error('缺少 moov box');

  const sounTrak = reader.findTrak(moov.children, 'soun');
  if (!sounTrak || !sounTrak.children) throw new Error('缺少音频轨');

  const sMdia = reader.findBox(sounTrak.children, 'mdia');
  if (!sMdia || !sMdia.children) throw new Error('音频轨缺少 mdia');

  const sMinf = reader.findBox(sMdia.children, 'minf');
  if (!sMinf || !sMinf.children) throw new Error('音频轨缺少 minf');

  const sStbl = reader.findBox(sMinf.children, 'stbl');
  if (!sStbl || !sStbl.children) throw new Error('音频轨缺少 stbl');

  const sStsz = reader.findBox(sStbl.children, 'stsz');
  if (!sStsz) throw new Error('音频轨缺少 stsz');

  const sCo64 = reader.findBox(sStbl.children, 'co64');
  const sStco = reader.findBox(sStbl.children, 'stco');
  const coBox = sCo64 || sStco;
  if (!coBox) throw new Error('音频轨缺少 co64/stco');

  // 2. 解析 stsz
  onProgress?.('解析音频帧表', 5);
  const stszData = sStsz.data;
  const stszDV = new DataView(stszData.buffer, stszData.byteOffset, stszData.length);
  const sampleSize = stszDV.getUint32(4, false);
  const sampleCount = stszDV.getUint32(8, false);

  if (sampleSize !== 0) throw new Error('音频轨不使用变长 sample，非 FIV 格式');

  const sampleSizes: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    sampleSizes.push(stszDV.getUint32(12 + i * 4, false));
  }

  if (sampleCount < 1) throw new Error('音频轨无 sample');

  // 3. 解析 co64/stco
  const isCo64 = coBox.type === 'co64';
  const coData = coBox.data;
  const coDV = new DataView(coData.buffer, coData.byteOffset, coData.length);
  const coEntryCount = coDV.getUint32(4, false);
  if (coEntryCount < 1) throw new Error('音频轨 chunk 偏移为空');

  let audioBaseOffset: number;
  if (isCo64) {
    audioBaseOffset = Number(coDV.getBigUint64(8, false));
  } else {
    audioBaseOffset = coDV.getUint32(8, false);
  }

  // 4. 验证 mdat 存在
  const mdat = topBoxes.find(b => b.type === 'mdat');
  if (!mdat) throw new Error('缺少 mdat box');

  // 音频数据从 co64 的绝对文件偏移开始
  const audioDataStart = audioBaseOffset;

  // 5. 读取帧 0
  onProgress?.('读取帧 0', 10);
  const sample0Size = sampleSizes[0];
  const sample0Buf = buf.slice(audioDataStart, audioDataStart + sample0Size);

  // 解析明文头
  const magic = new DataView(sample0Buf.buffer, sample0Buf.byteOffset, 4).getUint32(0, false);
  if (magic !== FIV1_MAGIC) throw new Error('不是有效的 FIV 文件（magic 不匹配）');

  const encMagic = sample0Buf.slice(4, 8);
  const frameSalt = sample0Buf.slice(8, 24);
  const iter = new DataView(sample0Buf.buffer, sample0Buf.byteOffset + 24, 4).getUint32(0, false);

  // 6. 解密验证
  onProgress?.('验证密码', 15);
  const { key } = await deriveKey(password, frameSalt, iter);

  const valid = await verifyEncMagic(key, encMagic);
  if (!valid) throw new Error('密码错误');

  // 7. 解密帧 0 加密区
  onProgress?.('解密文件索引', 20);
  const frame0EncData = sample0Buf.slice(FRAME0_HEADER_SIZE);
  const ctr = new AesCtrStream(key, 1); // counter=1

  const frame0Decrypted = await ctr.decrypt(frame0EncData);

  const f0DV = new DataView(frame0Decrypted.buffer, frame0Decrypted.byteOffset, frame0Decrypted.length);
  const fileCount = Number(f0DV.getBigUint64(0, false));

  // 解析 file entries
  const dec = new TextDecoder();
  const entries: { name: string; size: number; nameLen: number; byteLen: number }[] = [];
  let eOff = 8;
  for (let i = 0; i < fileCount; i++) {
    const nameLen = f0DV.getUint16(eOff, false);
    const dataLen = Number(f0DV.getBigUint64(eOff + 2, false));
    const name = dec.decode(frame0Decrypted.slice(eOff + 10, eOff + 10 + nameLen));
    entries.push({ name, size: dataLen, nameLen, byteLen: 2 + 8 + nameLen });
    eOff += 10 + nameLen;
  }

  // 8. 计算偏移表
  onProgress?.('计算数据偏移', 25);
  const sampleOffsets: number[] = [];
  let off = audioDataStart;
  for (let i = 0; i < sampleCount; i++) {
    sampleOffsets.push(off);
    off += sampleSizes[i];
  }

  // 9. 读取并解密文件数据
  const files: DecodedFile[] = [];
  let totalRead = 0;
  const totalDataSize = entries.reduce((s, e) => s + e.size, 0);

  let sampleIdx = 1; // 从 sample 1 开始（0 是元数据帧）
  let bufOffset = 0; // 当前 sample 内的偏移

  for (const entry of entries) {
    const chunks: Uint8Array[] = [];
    let remaining = entry.size;

    while (remaining > 0 && sampleIdx < sampleCount) {
      const sampleSize = sampleSizes[sampleIdx];
      const availInSample = sampleSize - bufOffset;
      const take = Math.min(remaining, availInSample);

      if (take > 0) {
        const chunk = buf.slice(
          sampleOffsets[sampleIdx] + bufOffset,
          sampleOffsets[sampleIdx] + bufOffset + take
        );
        chunks.push(chunk);
        remaining -= take;
        totalRead += take;
        bufOffset += take;

        const pct = 30 + Math.floor((totalRead / totalDataSize) * 65);
        if (totalRead % (1024 * 1024) < 10000) {
          onProgress?.('解密文件数据', pct);
        }
      }

      if (bufOffset >= sampleSize) {
        sampleIdx++;
        bufOffset = 0;
      }
    }

    // 拼接 + 解密
    const totalLen = chunks.reduce((s, c) => s + c.length, 0);
    const combined = new Uint8Array(totalLen);
    let co = 0;
    for (const c of chunks) {
      combined.set(c, co);
      co += c.length;
    }

    const decrypted = await ctr.decrypt(combined);

    files.push({
      name: entry.name,
      size: entry.size,
      blob: new Blob([decrypted.slice(0, entry.size)]),
    });
  }

  onProgress?.('完成', 100);

  return { files };
}
