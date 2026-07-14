/**
 * 封面 MP4 解析器
 * 提取 H.264 视频轨的全部参数和帧数据
 */

import { BoxReader, ParsedBox } from './isobmff/reader';
import { CoverInfo, VideoFrameInfo } from './types';

/** STTS entry: sample_count + sample_delta */
interface SttsEntry { count: number; delta: number; }

/** STSC entry: first_chunk + samples_per_chunk + sample_description_index */
interface StscEntry { firstChunk: number; samplesPerChunk: number; descIndex: number; }

export async function parseCoverMp4(file: File | Blob): Promise<CoverInfo> {
  const buf = await file.arrayBuffer();
  const reader = new BoxReader(buf);

  const topBoxes = reader.parseTopLevel();

  // 找 moov
  const moov = reader.findBox(topBoxes, 'moov');
  if (!moov || !moov.children) throw new Error('封面 MP4 缺少 moov box');

  // 找视频轨 (vide handler)
  const videTrak = reader.findTrak(moov.children, 'vide');
  if (!videTrak || !videTrak.children) throw new Error('封面 MP4 缺少视频轨');

  // 解析 mdia
  const mdia = reader.findBox(videTrak.children, 'mdia');
  if (!mdia || !mdia.children) throw new Error('视频轨缺少 mdia');

  // mdhd
  const mdhd = reader.findBox(mdia.children, 'mdhd');
  if (!mdhd) throw new Error('视频轨缺少 mdhd');

  const mdhdData = mdhd.data;
  const version = mdhdData[0];
  let timescale: number;
  let duration: number;
  if (version === 1) {
    timescale = new DataView(mdhdData.buffer, mdhdData.byteOffset + 20, 4).getUint32(0, false);
    duration = Number(new DataView(mdhdData.buffer, mdhdData.byteOffset + 24, 8).getBigUint64(0, false));
  } else {
    timescale = new DataView(mdhdData.buffer, mdhdData.byteOffset + 12, 4).getUint32(0, false);
    duration = new DataView(mdhdData.buffer, mdhdData.byteOffset + 16, 4).getUint32(0, false);
  }

  // elst: 提取 media_time（B 帧重排序依赖）
  let elstMediaTime = 0;
  const edts = reader.findBox(videTrak.children, 'edts');
  if (edts && edts.children) {
    const elst = reader.findBox(edts.children, 'elst');
    if (elst) {
      const ev = elst.data[0];
      const ec = new DataView(elst.data.buffer, elst.data.byteOffset + 4, 4).getUint32(0, false);
      if (ec > 0) {
        if (ev === 1) {
          elstMediaTime = Number(new DataView(elst.data.buffer, elst.data.byteOffset + 20, 8).getBigInt64(0, false));
        } else {
          elstMediaTime = new DataView(elst.data.buffer, elst.data.byteOffset + 12, 4).getInt32(0, false);
        }
      }
    }
  }

  // minf → stbl
  const minf = reader.findBox(mdia.children, 'minf');
  if (!minf || !minf.children) throw new Error('视频轨缺少 minf');

  const stbl = reader.findBox(minf.children, 'stbl');
  if (!stbl || !stbl.children) throw new Error('视频轨缺少 stbl');

  // stsd → avc1 → avcC
  const stsd = reader.findBox(stbl.children, 'stsd');
  if (!stsd) throw new Error('视频轨缺少 stsd');

  // 保存完整 stsd data（后面直接写回，避免手拼 avc1 的构造差异）
  const stsdData = stsd.data;
  const stsdDV = new DataView(stsdData.buffer, stsdData.byteOffset, stsdData.length);
  const entryCount = stsdDV.getUint32(4, false);

  let avcC: Uint8Array | null = null;
  let width = 0, height = 0;

  let entryOffset = 8;
  for (let i = 0; i < entryCount && entryOffset < stsdData.length; i++) {
    const entrySize = stsdDV.getUint32(entryOffset, false);
    const entryFmt = String.fromCharCode(
      stsdData[entryOffset + 4], stsdData[entryOffset + 5],
      stsdData[entryOffset + 6], stsdData[entryOffset + 7]
    );

    if (entryFmt === 'avc1') {
      width = stsdDV.getUint16(entryOffset + 32, false);
      height = stsdDV.getUint16(entryOffset + 34, false);

      // 扫描子 box 找 avcC
      let subOffset = entryOffset + 86; // 跳过 VisualSampleEntry 固定头
      while (subOffset < entryOffset + entrySize - 7) {
        const subSize = stsdDV.getUint32(subOffset, false);
        const subType = String.fromCharCode(
          stsdData[subOffset + 4], stsdData[subOffset + 5],
          stsdData[subOffset + 6], stsdData[subOffset + 7]
        );
        if (subType === 'avcC') {
          avcC = stsdData.slice(subOffset, subOffset + subSize);
          break;
        }
        subOffset += subSize;
      }
      break;
    }
    entryOffset += entrySize;
  }

  if (!avcC) throw new Error('封面 MP4 缺少 avcC box');
  if (width === 0 || height === 0) throw new Error('无法读取视频分辨率');

  // 读取 stbl 各表
  const sttsBox = reader.findBox(stbl.children, 'stts');
  const stscBox = reader.findBox(stbl.children, 'stsc');
  const stszBox = reader.findBox(stbl.children, 'stsz');
  const stssBox = reader.findBox(stbl.children, 'stss');
  const stcoBox = reader.findBox(stbl.children, 'stco');
  const co64Box = reader.findBox(stbl.children, 'co64');

  if (!sttsBox || !stscBox || !stszBox) throw new Error('封面 MP4 缺少 stbl 表');

  // co64 / stco
  const coBox = co64Box || stcoBox;
  if (!coBox) throw new Error('封面 MP4 缺少 co64/stco');

  // 解析 stts
  const sttsEntries = parseStts(sttsBox.data);

  // 解析 stsc
  const stscEntries = parseStsc(stscBox.data);

  // 解析 stsz
  const stszSizes = parseStsz(stszBox.data);

  // 解析 stss
  const syncSamples = stssBox ? parseStss(stssBox.data) : new Set<number>();

  // 解析 co64/stco
  const isCo64 = coBox.type === 'co64';
  const coData = coBox.data;
  const coVersion = coData[0];
  const coEntryCount = new DataView(coData.buffer, coData.byteOffset + 4, 4).getUint32(0, false);

  const chunkOffsets: number[] = [];
  for (let i = 0; i < coEntryCount; i++) {
    if (isCo64) {
      chunkOffsets.push(Number(
        new DataView(coData.buffer, coData.byteOffset + 8 + i * 8, 8).getBigUint64(0, false)
      ));
    } else {
      chunkOffsets.push(
        new DataView(coData.buffer, coData.byteOffset + 8 + i * 4, 4).getUint32(0, false)
      );
    }
  }

  // 构建视频帧列表：chunk → sample 映射
  const frames: VideoFrameInfo[] = [];
  let stscIdx = 0;
  let sampleIdx = 0;

  for (let chunk = 0; chunk < chunkOffsets.length; chunk++) {
    // 确定当前 chunk 的 samples_per_chunk
    while (
      stscIdx + 1 < stscEntries.length &&
      chunk + 1 >= stscEntries[stscIdx + 1].firstChunk
    ) {
      stscIdx++;
    }
    const spc = stscEntries[stscIdx].samplesPerChunk;

    let chunkOffset = chunkOffsets[chunk];

    for (let s = 0; s < spc; s++) {
      if (sampleIdx >= stszSizes.length) break;
      const size = stszSizes[sampleIdx];
      frames.push({
        offset: chunkOffset,
        size,
        isSync: syncSamples.size === 0 || syncSamples.has(sampleIdx + 1),
      });
      chunkOffset += size;
      sampleIdx++;
    }
  }

  // 读取 mdat（顶层遍历，不依赖递归 findBox）
  const mdat = topBoxes.find(b => b.type === 'mdat');
  if (!mdat) throw new Error('封面 MP4 缺少 mdat box（请确认视频为 H.264 编码的标准 MP4）');

  const mdatStart = mdat.offset;
  const mdatData = new Uint8Array(buf).slice(mdatStart, mdatStart + mdat.size);

  // stbl 表数据（供编码器写回）
  const sttsData = sttsBox.data;
  const stscData = stscBox.data;
  const stszData = stszBox.data;
  const stssData = stssBox?.data ?? new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]); // 空 stss

  // 提取 ctts（B 帧重排序）和 sdtp（依赖类型），缺失不影响无 B 帧流
  const cttsBox = reader.findBox(stbl.children, 'ctts');
  const sdtpBox = reader.findBox(stbl.children, 'sdtp');
  const cttsData = cttsBox?.data ?? null;
  const sdtpData = sdtpBox?.data ?? null;

  const co64Entries = chunkOffsets.map(o => ({ offset: o }));

  return {
    frames,
    avcC,
    stsdData,
    timescale,
    duration,
    width,
    height,
    stts: sttsData,
    stsc: stscData,
    stsz: stszData,
    stss: stssData,
    ctts: cttsData,
    sdtp: sdtpData,
    elstMediaTime,
    co64Entries,
    mdatData,
    mdatStart,
  };
}

function parseStts(data: Uint8Array): SttsEntry[] {
  const dv = new DataView(data.buffer, data.byteOffset, data.length);
  const version = data[0];
  const count = dv.getUint32(4, false);
  const entries: SttsEntry[] = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      count: dv.getUint32(8 + i * 8, false),
      delta: dv.getUint32(12 + i * 8, false),
    });
  }
  return entries;
}

function parseStsc(data: Uint8Array): StscEntry[] {
  const dv = new DataView(data.buffer, data.byteOffset, data.length);
  const count = dv.getUint32(4, false);
  const entries: StscEntry[] = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      firstChunk: dv.getUint32(8 + i * 12, false),
      samplesPerChunk: dv.getUint32(12 + i * 12, false),
      descIndex: dv.getUint32(16 + i * 12, false),
    });
  }
  return entries;
}

function parseStsz(data: Uint8Array): number[] {
  const dv = new DataView(data.buffer, data.byteOffset, data.length);
  const version = data[0];
  const sampleSize = dv.getUint32(4, false);
  const count = dv.getUint32(8, false);

  if (sampleSize !== 0) {
    // 等长
    return new Array(count).fill(sampleSize);
  }

  const sizes: number[] = [];
  for (let i = 0; i < count; i++) {
    sizes.push(dv.getUint32(12 + i * 4, false));
  }
  return sizes;
}

function parseStss(data: Uint8Array): Set<number> {
  const dv = new DataView(data.buffer, data.byteOffset, data.length);
  const count = dv.getUint32(4, false);
  const sync = new Set<number>();
  for (let i = 0; i < count; i++) {
    sync.add(dv.getUint32(8 + i * 4, false));
  }
  return sync;
}
