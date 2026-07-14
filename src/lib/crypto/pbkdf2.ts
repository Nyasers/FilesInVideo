/**
 * PBKDF2 密钥派生（Web Crypto API）
 */

import { PBKDF2_ITERATIONS, AES_KEY_LEN, AES_BLOCK, FIV1_MAGIC } from '../types';

export interface DerivedKey {
  key: CryptoKey;
  frameSalt: Uint8Array;
}

/** 从密码 + salt 派生 AES-256 密钥 */
export async function deriveKey(
  password: string,
  frameSalt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS
): Promise<DerivedKey> {
  const enc = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: frameSalt,
      iterations,
      hash: 'SHA-256',
    },
    passwordKey,
    { name: 'AES-CTR', length: AES_KEY_LEN },
    false,
    ['encrypt', 'decrypt']
  );

  return { key, frameSalt };
}

/** 生成 encMagic：加密 "FIV1" 的 AES-CTR 结果前 4 字节 */
export async function createEncMagic(
  key: CryptoKey,
  frameSalt: Uint8Array
): Promise<Uint8Array> {
  const magic = new Uint8Array([0x46, 0x49, 0x56, 0x31]); // "FIV1"
  const counter = new Uint8Array(AES_BLOCK);
  // counter=0

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-CTR', counter, length: 128 },
    key,
    magic.slice(0, AES_BLOCK) // pad to 16 bytes
  );

  return new Uint8Array(encrypted).slice(0, 4);
}

/** 验证 encMagic：解密后比对 "FIV1" */
export async function verifyEncMagic(
  key: CryptoKey,
  encMagic: Uint8Array
): Promise<boolean> {
  const counter = new Uint8Array(AES_BLOCK);
  // counter=0

  // 解密时需要 padded 到 16 字节
  const padded = new Uint8Array(AES_BLOCK);
  padded.set(encMagic, 0);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-CTR', counter, length: 128 },
    key,
    padded
  );

  const dec = new Uint8Array(decrypted);
  return dec[0] === 0x46 && dec[1] === 0x49 && dec[2] === 0x56 && dec[3] === 0x31;
}
