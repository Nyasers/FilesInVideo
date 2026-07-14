/**
 * ISOBMFF Box 解析器
 * 遍历 MP4 文件中的 box tree
 */

export interface ParsedBox {
  type: string;
  size: number;
  offset: number;
  data: Uint8Array;
  children?: ParsedBox[];
}

export class BoxReader {
  private buf: Uint8Array;
  private dataView: DataView;

  constructor(buf: ArrayBuffer | Uint8Array) {
    this.buf = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.dataView = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
  }

  /** 读取 uint32 BE */
  readU32(offset: number): number {
    return this.dataView.getUint32(offset, false);
  }

  /** 读取 uint64 BE */
  readU64(offset: number): bigint {
    return this.dataView.getBigUint64(offset, false);
  }

  /** 读取 FourCC */
  readFourCC(offset: number): string {
    return String.fromCharCode(
      this.buf[offset],
      this.buf[offset + 1],
      this.buf[offset + 2],
      this.buf[offset + 3]
    );
  }

  /** 解析顶层 box 列表 */
  parseTopLevel(): ParsedBox[] {
    const boxes: ParsedBox[] = [];
    let offset = 0;
    while (offset < this.buf.length - 7) {
      const box = this.parseAt(offset);
      if (!box) break;
      boxes.push(box);
      offset += box.size;
    }
    return boxes;
  }

  /** 在指定偏移处解析一个 box */
  parseAt(offset: number): ParsedBox | null {
    if (offset + 8 > this.buf.length) return null;

    let size: number;
    let dataStart: number;

    const rawSize = this.readU32(offset);
    if (rawSize === 0) {
      // 扩展到文件末
      size = this.buf.length - offset;
      dataStart = offset + 8;
    } else if (rawSize === 1) {
      // largesize: [4B size=1][4B type][8B largesize][data]
      if (offset + 16 > this.buf.length) return null;
      size = Number(this.readU64(offset + 8));
      dataStart = offset + 16;
    } else if (rawSize < 8) {
      return null;
    } else {
      size = rawSize;
      dataStart = offset + 8;
    }

    if (offset + size > this.buf.length) {
      size = this.buf.length - offset;
    }

    // type 永远在 offset+4（对所有 box 格式一致）
    const type = this.readFourCC(offset + 4);

    const dataLen = size - (dataStart - offset);

    const data = this.buf.slice(dataStart, dataStart + dataLen);

    const box: ParsedBox = { type, size, offset, data };

    // 容器 box 递归解析子 box
    if (this.isContainer(type)) {
      box.children = [];
      let childOffset = 0;
      while (childOffset < dataLen - 7) {
        // 在子数据中解析，需要构造全局偏移
        const childBox = this.parseSubBox(data, childOffset, dataStart + childOffset);
        if (!childBox) break;
        box.children.push(childBox);
        childOffset += childBox.size;
      }
    }

    return box;
  }

  /** 在子 buffer 中解析 box */
  private parseSubBox(buf: Uint8Array, offset: number, globalOffset: number): ParsedBox | null {
    if (offset + 8 > buf.length) return null;

    let size: number;
    let dataStart: number;

    const rawSize = new DataView(buf.buffer, buf.byteOffset + offset, 4).getUint32(0, false);
    if (rawSize === 0) {
      size = buf.length - offset;
      dataStart = offset + 8;
    } else if (rawSize === 1) {
      if (offset + 16 > buf.length) return null;
      size = Number(new DataView(buf.buffer, buf.byteOffset + offset + 8, 8).getBigUint64(0, false));
      dataStart = offset + 16;
    } else if (rawSize < 8) {
      return null;
    } else {
      size = rawSize;
      dataStart = offset + 8;
    }

    if (offset + size > buf.length) size = buf.length - offset;

    // type 永远在 offset+4
    const type = String.fromCharCode(
      buf[offset + 4], buf[offset + 5], buf[offset + 6], buf[offset + 7]
    );

    const dataLen = size - (dataStart - offset);
    const data = buf.slice(dataStart, dataStart + dataLen);

    const box: ParsedBox = { type, size, offset: globalOffset, data };

    if (this.isContainer(type)) {
      box.children = [];
      let childOff = 0;
      while (childOff < dataLen - 7) {
        const child = this.parseSubBox(data, childOff, globalOffset + (dataStart - offset) + childOff);
        if (!child) break;
        box.children.push(child);
        childOff += child.size;
      }
    }

    return box;
  }

  /** 查找 box */
  findBox(boxes: ParsedBox[], type: string): ParsedBox | undefined {
    for (const box of boxes) {
      if (box.type === type) return box;
      if (box.children) {
        const found = this.findBox(box.children, type);
        if (found) return found;
      }
    }
  }

  /** 查找所有匹配 box */
  findAll(boxes: ParsedBox[], type: string): ParsedBox[] {
    const result: ParsedBox[] = [];
    for (const box of boxes) {
      if (box.type === type) result.push(box);
      if (box.children) result.push(...this.findAll(box.children, type));
    }
    return result;
  }

  /** 遍历找 trak */
  findTrak(boxes: ParsedBox[], handlerType: string): ParsedBox | undefined {
    for (const box of boxes) {
      if (box.type === 'trak' && box.children) {
        const hdlr = this.findBox(box.children, 'hdlr');
        if (hdlr) {
          const hType = String.fromCharCode(
            hdlr.data[8], hdlr.data[9], hdlr.data[10], hdlr.data[11]
          );
          if (hType === handlerType) return box;
        }
      }
    }
  }

  /** 容器 box 类型 */
  private isContainer(type: string): boolean {
    return ['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts'].includes(type);
  }
}
