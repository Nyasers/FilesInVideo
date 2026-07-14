/**
 * ISOBMFF Box 构建器
 * 在内存中构建完整的 box tree，最后序列化输出
 */

const U32_MAX = 0xffffffff;
const U64_MAX = BigInt('0xffffffffffffffff');

export class BoxBuilder {
  private chunks: Uint8Array[] = [];
  private stack: number[] = []; // 每层 box 的大小位置索引

  /** 获取当前已写入的总字节数 */
  get length(): number {
    return this.chunks.reduce((s, c) => s + c.byteLength, 0);
  }

  /** 写入原始字节 */
  write(data: Uint8Array): void {
    this.chunks.push(data);
  }

  /** 写入 uint32 BE */
  writeU32(v: number): void {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, v, false);
    this.chunks.push(buf);
  }

  /** 写入 uint64 BE */
  writeU64(v: number | bigint): void {
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setBigUint64(0, BigInt(v), false);
    this.chunks.push(buf);
  }

  /** 写入 FourCC (uint32 BE) */
  writeFourCC(s: string): void {
    if (s.length !== 4) throw new Error(`Invalid FourCC: ${s}`);
    const buf = new Uint8Array(4);
    for (let i = 0; i < 4; i++) buf[i] = s.charCodeAt(i);
    this.chunks.push(buf);
  }

  /** 写入 uint16 BE */
  writeU16(v: number): void {
    const buf = new Uint8Array(2);
    new DataView(buf.buffer).setUint16(0, v, false);
    this.chunks.push(buf);
  }

  /** 写入 uint8 */
  writeU8(v: number): void {
    this.chunks.push(new Uint8Array([v]));
  }

  /** 写入 1-byte version + 3-byte flags */
  writeVersion(v: number, flags: number = 0): void {
    this.writeU8(v);
    this.writeU8((flags >> 16) & 0xff);
    this.writeU8((flags >> 8) & 0xff);
    this.writeU8(flags & 0xff);
  }

  /** 写入固定值数组 */
  writeFixed(len: number, v: number = 0): void {
    this.chunks.push(new Uint8Array(len).fill(v));
  }

  /** 开始一个 box（写入 size placeholder + type） */
  startBox(fourcc: string): number {
    const pos = this.chunks.length;
    this.writeU32(0); // placeholder size
    this.writeFourCC(fourcc);
    this.stack.push(pos);
    return pos;
  }

  /** 结束当前嵌套 box，回填 size（小端法：size + body） */
  endBox(): void {
    const pos = this.stack.pop();
    if (pos === undefined) throw new Error('Unbalanced endBox()');

    // 计算当前 box 总大小 = 从 pos 开始到现在的总字节数
    let size = 0;
    for (let i = pos; i < this.chunks.length; i++) {
      size += this.chunks[i].byteLength;
    }

    // 回填到 placeholder
    const dv = new DataView(this.chunks[pos].buffer, this.chunks[pos].byteOffset, 4);
    if (size <= U32_MAX) {
      dv.setUint32(0, size, false);
    } else {
      // 需要 largesize: size=1, 后跟 8B 实际大小
      // 简化处理：先写 1，然后把当前 chunks 中 size 后的部分替换
      dv.setUint32(0, 1, false);
      // 插入 u64 size 到 type 后面
      const typeChunk = this.chunks[pos + 1]; // FourCC
      // 重建：size(4) + type(4) + largesize(8) -> 移除原来的 type，重组
      const largesize = new Uint8Array(8);
      // size 是不含 largesize 字段的原始总计，加上 8B largesize 自身
      new DataView(largesize.buffer).setBigUint64(0, BigInt(size) + 8n, false);

      // 替换 type chunk: type + largesize
      const combined = new Uint8Array(12);
      combined.set(typeChunk, 0); // type at 0..3
      combined.set(largesize, 4); // largesize at 4..11
      this.chunks[pos + 1] = combined;
    }
  }

  /** 构建完整 buffer */
  build(): Uint8Array {
    const total = this.length;
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  /** 构建为 Blob */
  buildBlob(type: string = ''): Blob {
    return new Blob([this.build()], type ? { type } : undefined);
  }

  /**
   * 便捷方法：构建单个完整 box
   */
  static buildBox(fourcc: string, fn: (b: BoxBuilder) => void): Uint8Array {
    const b = new BoxBuilder();
    b.startBox(fourcc);
    fn(b);
    b.endBox();
    return b.build();
  }

  /**
   * 从 ArrayBuffer 切片构建子 box
   */
  static fromBuffer(buf: Uint8Array, offset: number, size: number): Uint8Array {
    return buf.slice(offset, offset + size);
  }
}
