export { encode, prepareEncode, buildStream } from './encoder';
export { decode } from './decoder';
export { parseCoverMp4 } from './cover-parser';
export type {
  EncodeOptions, EncodeResult, PrepareResult,
  DecodeOptions, DecodeResult,
  FileEntry, DecodedFile, CoverInfo,
} from './types';
