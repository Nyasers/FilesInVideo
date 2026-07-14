/** ISOBMFF 常量 & 工具 */

/** 版本 */
export const FIV_VERSION = 1;

/** 魔数 */
export const FIV1_MAGIC = 0x46495631; // "FIV1"

/** 帧 0 明文头长度 */
export const FRAME0_HEADER_SIZE = 28; // magic(4) + encMagic(4) + frameSalt(16) + iter(4)

/** PBKDF2 迭代次数 */
export const PBKDF2_ITERATIONS = 10000;

/** AES key 长度（256-bit） */
export const AES_KEY_LEN = 256;

/** AES block size */
export const AES_BLOCK = 16;

/** 音频采样参数（仅用于 stsd 字段填充） */
export const SOWT_SAMPLE_RATE = 44100;
export const SOWT_CHANNELS = 1;
export const SOWT_BITS = 16;

/** 文件条目：2B nameLen + 8B dataLen + UTF-8 name */
export interface FileEntry {
  name: string;
  size: number;
  data: Blob | ArrayBuffer;
}

/** 封面视频解析结果 */
export interface CoverInfo {
  frames: VideoFrameInfo[];
  avcC: Uint8Array;
  timescale: number;
  duration: number;
  width: number;
  height: number;
  /** 视频轨 stbl 各表原始数据 */
  stts: Uint8Array;
  stsc: Uint8Array;
  stsz: Uint8Array;
  stss: Uint8Array;
  ctts: Uint8Array | null;
  sdtp: Uint8Array | null;
  /** 完整 stsd box data（含 version+flags+entry_count+entries） */
  stsdData: Uint8Array;
  elstMediaTime: number;
  co64Entries: Co64Entry[];
  /** 视频轨 mdat offset（视频数据在 mdat 中的起始） */
  mdatData: Uint8Array;
  /** mdat 起始在文件中的偏移 */
  mdatStart: number;
}

export interface VideoFrameInfo {
  offset: number;
  size: number;
  isSync: boolean;
}

export interface Co64Entry {
  offset: number;
}

/** 编码选项 */
export interface EncodeOptions {
  coverVideo: File | Blob;
  files: FileEntry[];
  password: string;
  /** @deprecated 自动计算，不再使用 */
  bytesPerSample?: number;
  onProgress?: (phase: string, percent: number) => void;
}

/** 准备阶段结果——无 I/O 阻塞，快速返回 */
export interface PrepareResult {
  cover: CoverInfo;
  key: CryptoKey;
  sample0Data: Uint8Array;
  sample0Size: number;
  audioSizes: number[];
  totalAudioFrames: number;
  audDuration: number;
  vidDuration: number;
  vidDataSize: number;
  audioDataSize: number;
  fileTotalData: number;
  fileCount: number;
  headerBlob: Blob;
  mdatTotalSize: number;
}

/** 编码结果 */
export interface EncodeResult {
  stream: ReadableStream<Uint8Array>;
  fileCount: number;
  totalDataSize: number;
  audioFrames: number;
  videoDuration: number;
}

/** 解码选项 */
export interface DecodeOptions {
  blob: Blob;
  password: string;
  onProgress?: (phase: string, percent: number) => void;
}

/** 解码结果 */
export interface DecodeResult {
  files: DecodedFile[];
}

export interface DecodedFile {
  name: string;
  size: number;
  blob: Blob;
}

/** ISOBMFF Box 类型 */
export const BoxTypes = {
  ftyp: 0x66747970,
  moov: 0x6d6f6f76,
  mvhd: 0x6d766864,
  trak: 0x7472616b,
  tkhd: 0x746b6864,
  edts: 0x65647473,
  elst: 0x656c7374,
  mdia: 0x6d646961,
  mdhd: 0x6d646864,
  hdlr: 0x68646c72,
  minf: 0x6d696e66,
  vmhd: 0x766d6864,
  smhd: 0x736d6864,
  dinf: 0x64696e66,
  dref: 0x64726566,
  stbl: 0x7374626c,
  stsd: 0x73747364,
  stts: 0x73747473,
  stsc: 0x73747363,
  stsz: 0x7374737a,
  stss: 0x73747373,
  co64: 0x636f3634,
  mdat: 0x6d646174,
  avc1: 0x61766331,
  avcC: 0x61766343,
  sowt: 0x736f7774,
  wave: 0x77617665,
  enda: 0x656e6461,
  free: 0x66726565,
  skip: 0x736b6970,
} as const;

export type BoxType = (typeof BoxTypes)[keyof typeof BoxTypes];
