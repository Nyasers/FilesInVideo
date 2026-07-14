/**
 * AES-CTR 流加密/解密
 *
 * Web Crypto API 的 AES-CTR 要求完整 block 操作。
 * 我们的帧间不重置 counter，需要维护 counter 状态。
 */

const AES_BLOCK = 16;

export class AesCtrStream {
  private key: CryptoKey;
  private counter: number;

  constructor(key: CryptoKey, startCounter: number = 0) {
    this.key = key;
    this.counter = startCounter;
  }

  /** 加密一段数据，counter 自动推进 */
  async encrypt(data: Uint8Array): Promise<Uint8Array> {
    return this.process(data, 'encrypt');
  }

  /** 解密一段数据，counter 自动推进 */
  async decrypt(data: Uint8Array): Promise<Uint8Array> {
    return this.process(data, 'decrypt');
  }

  /** 获取当前 counter 值 */
  getCounter(): number { return this.counter; }

  private async process(data: Uint8Array, op: 'encrypt' | 'decrypt'): Promise<Uint8Array> {
    if (data.length === 0) return data;

    // AES-CTR 要求 16 字节对齐
    const paddedLen = Math.ceil(data.length / AES_BLOCK) * AES_BLOCK;
    const padded = data.length === paddedLen
      ? data
      : (() => { const p = new Uint8Array(paddedLen); p.set(data, 0); return p; })();

    // 构造 counter block
    const counterBytes = this.buildCounter(this.counter);

    const result = await crypto.subtle[op](
      { name: 'AES-CTR', counter: counterBytes, length: 128 },
      this.key,
      padded
    );

    // 推进 counter
    this.counter += paddedLen / AES_BLOCK;

    // 截取原始长度
    const full = new Uint8Array(result);
    if (data.length === paddedLen) return full;
    return full.slice(0, data.length);
  }

  /**
   * 加密数据（已知 counter 对齐情况，处理 prePad）
   * 当上一帧结尾不是 16 字节对齐时，本帧需要 prePad。
   *
   * 编码流程：
   *   1. 如果有 prePad（上一帧结尾剩余的 block 空间），在 data 前面补 prePad 个零
   *   2. counter 不变（因为上一帧已经推进到位）
   *   3. 加密 paddedData
   *   4. 去掉 prePad 字节，返回实际加密数据
   */
  async encryptAligned(data: Uint8Array, prePad: number): Promise<Uint8Array> {
    if (prePad === 0) return this.encrypt(data);

    const padded = new Uint8Array(prePad + data.length);
    // prePad 字节保持 0
    padded.set(data, prePad);

    const encrypted = await this.encrypt(padded);
    return encrypted.slice(prePad);
  }

  /**
   * 解密数据（对齐读，counter 从上一帧接续）
   */
  async decryptAligned(data: Uint8Array, prePad: number): Promise<Uint8Array> {
    if (prePad === 0) return this.decrypt(data);

    const padded = new Uint8Array(prePad + data.length);
    padded.set(data, prePad);

    const decrypted = await this.decrypt(padded);
    return decrypted.slice(prePad);
  }

  /** 构建 AES-CTR counter buffer (128-bit, BE) */
  private buildCounter(counter: number): Uint8Array {
    const buf = new Uint8Array(AES_BLOCK);
    // counter 写入高 64 位（AES-CTR 计数通常从高位移到低位）
    // 简化：counter 写入低 64 位，高 64 位为 0
    const dv = new DataView(buf.buffer, buf.byteOffset, AES_BLOCK);
    // 用 BigInt: 高 64 bits = 0，低 64 bits = counter
    dv.setBigUint64(8, BigInt(counter), false);
    return buf;
  }
}
