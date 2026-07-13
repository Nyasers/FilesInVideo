# FIV · ISOBMFF 双轨容器设计

## 核心概念

把加密文件数据藏在正常视频的音频轨里。视频轨是用户提供的封面 MP4（H.264），音频轨是 PCM 原始采样通道（实际承载加密文件数据）。浏览器解码视频正常播放，碰到不认识的 `sowt` 音频编码直接跳过，不报错、不出声。

## 核心约束

- 封面视频由用户提供：任意 H.264 + AAC 的 MP4，FIV 只做容器级 remux
- 只取视频轨，丢弃原音轨（如果有）
- 视频帧通过 Edit List（elst）循环复用，mdat 中只存一份封面数据
- 全局数据级加密：单根 AES-CTR 流贯穿所有文件数据
- 帧 0 只承载加密上下文 + 元数据，帧 1..N 纯加密文件数据
- 所有帧通过音频轨 stsz（精确大小 + 前缀和定位）
- 一次身份验证覆盖全局（帧 0 的 encMagic）
- 容器格式：ISOBMFF MP4，双轨（avc1 视频 + sowt 音频）
- 音频参数：16-bit PCM 单声道 little-endian，采样率仅填充 stsd 字段，浏览器不解码

## 容器布局

```
ftyp (isom + avc1 兼容品牌)

moov
  ├─ mvhd
  ├─ trak (vide)
  │   ├─ tkhd (duration = 播放总时长 = N × cover_dur)
  │   ├─ edts → elst (N 条，每条指向 media_time=0，播放 cover_dur)
  │   └─ mdia
  │       ├─ mdhd (duration = cover_dur，媒体实际时长)
  │       ├─ hdlr 'vide'
  │       └─ minf
  │           ├─ vmhd
  │           ├─ dinf → dref
  │           └─ stbl
  │               ├─ stsd: avc1 + avcC/config
  │               ├─ stts (仅封面原始帧)
  │               ├─ stsc
  │               ├─ stsz (仅封面原始帧大小)
  │               ├─ stss (原始关键帧索引)
  │               └─ co64
  └─ trak (soun)
      ├─ tkhd
      └─ mdia
          ├─ mdhd
          ├─ hdlr 'soun'
          └─ minf
              ├─ smhd
              ├─ dinf → dref
              └─ stbl
                  ├─ stsd: sowt (16-bit PCM LE, 1ch, 44100 Hz)
                  ├─ stts (1 条: N_audio samples, uniform delta)
                  ├─ stsc (1 条: N_audio samples → 1 chunk)
                  ├─ stsz (N_audio 条，每 sample 精确大小)
                  └─ co64 (1 条)

mdat
  ├─ [封面视频帧 ×1] (H.264 码流，只存一份)
  └─ [加密文件数据] (AES-CTR, 帧 0 + 帧 1..N)
```

视频数据在 mdat 中只存一份，elst 使其循环播放 N 次。音频数据紧跟视频数据之后。

## 加密模型

### 密钥派生

```
frameSalt = random(16)
key = PBKDF2(password, frameSalt, iter=10000, hash=SHA-256) → AES-256-CTR
```

### 身份验证

```
encMagic = AES-CTR("FIV1" (4B), key, frameSalt, counter=0, bits=128).subarray(0, 4)
```

解码端加密固定明文 `"FIV1"`，与帧 0 明文头中的 encMagic 比对。不匹配则密码错误。

### 数据加密

```
流起始 counter = 1
帧 0:  AES-CTR(fileCount + fileEntries, key, frameSalt, counter=1)
帧 1:  AES-CTR(文件数据块1,   key, frameSalt, counter=1+floor(S0/16))
...
帧 i:  counter = 1 + floor(累计字节数 / 16), prePad = 累计字节数 % 16
```

帧间不重置 counter。帧 i 的加密流从帧 i-1 结束处接续。编码时 prePad 补零对齐 16 字节块边界，只写实际字节；解码时对齐读、补零解密、切出实际数据。

### 常数

```
FIV1 = 0x46495631
FRAME0_HEADER_SIZE = 28   // magic(4) + encMagic(4) + frameSalt(16) + iter(4)
PBKDF2_ITER = 10000
```

## 帧结构

### 帧 0（元数据帧 / audio sample 0）

```
offset  size  field              note
  0      4    magic=0x46495631   明文 "FIV1"
  4      4    encMagic           4B AES-CTR 验证
  8     16    frameSalt          16B 随机
 24      4    iter               PBKDF2 迭代次数
                                 -- AES-CTR 加密区从此开始 --
 28      8    fileCount          文件总数 (大端 8B)
 36      ?    fileEntries        文件条目列表
```

sample[0].size = FRAME0_HEADER_SIZE + frame0EncData（精确值，不填充）。

`frame0EncData = 8 + fileListSize`，`fileListSize` = 每条目 (nameLen(2B) + dataLen(8B) + name(UTF-8))。

### 帧 1..N-1（满数据帧 / audio sample 1..N-1）

纯加密文件数据。每个 sample 大小 = `bytesPerSample`（用户指定）。

### 帧 N-1（末帧，精确大小，不填充）

```
rem = fileTotalData - (N-2) × bytesPerSample
sample[N-1].size = rem
```

无零填充。stsz 记精确值。

## 封面视频处理

### 解析封面 MP4

```
cover MP4 → 提取:
  - avcC box (SPS + PPS, 从 avc1 stsd 中复制完整 box)
  - stss 表 (关键帧在原始封面中的 sample 索引)
  - 视频帧列表: [{ size, data, is_sync }]
  - timescale, duration (从 mdhd)
  - 分辨率 (从 tkhd 或 avc1 stsd)
```

仅提取视频轨。原音频轨丢弃。

### Edit List 循环（不复制数据）

ISOBMFF 的 Edit List Box（`elst`，在 `edts` 下）定义播放时间线到媒体时间线的映射。一条媒体段可以被 elst 引用多次，mdat 中只存一份视频帧：

```
封面共 M 帧，媒体时长 = cover_dur (mdhd.duration)
循环次数 N = ceil(目标_audio_时长 / cover_dur)

elst:  N 条 entry
  entry[k]: segment_duration = cover_dur, media_time = 0, media_rate = 1.0
```

每条 entry 将播放指针跳回 `media_time=0`，复用同一段视频帧。Chrome 从 IDR 帧开始解码，参考依赖链完整，不会花屏。

### 视频轨参数

```
tkhd.duration = N × cover_dur  (播放总时长)
mdhd.duration = cover_dur       (媒体实际时长)
mdhd.timescale = 封面原始 timescale
elst.entry_count = N
elst.entry[k].segment_duration = cover_dur
elst.entry[k].media_time = 0
```

视频轨 stbl（stsz/stts/stsc/stss）保持封面原始值，不做任何修改。

## sowt 音频 stsd

AudioSampleEntry 在 stsd 内的布局（entry_size 含 8B 头部 + 体 + wave 子 box）：

```
AudioSampleEntry (sowt), 总大小 54B:
  offset rel to entry start
    0      4     entry_size         54
    4      4     format             'sowt' (0x74776F73)
    8      6     reserved           0
   14      2     data_ref_index     1
   16      2     version            0
   18      2     revision           0
   20      4     vendor             0
   24      2     channels           1
   26      2     sample_size        16
   28      2     compression_id     0
   30      2     packet_size        0
   32      4     sample_rate        (44100 << 16)  16.16 fixed-point

   // wave box (endianness)
   36      4     size               18
   40      4     type               'wave'
   44      4     size               10
   48      4     type               'enda'
   52      2     little_endian      1
```

> `sowt` 在 QuickTime 中是 16-bit signed PCM little-endian。ISOBMFF 继承关系使其合法但浏览器内置解码器通常不注册此 FourCC。

## 预计算

```
输入: files[], bytesPerSample, coverInfo

fileListSize = Σ (2 + 8 + nameByteLen)
fileTotalData = Σ file.size

frame0EncData = 8 + fileListSize
sample0_size = FRAME0_HEADER_SIZE + frame0EncData

dataPerSample = bytesPerSample
dataFrameCount = fileTotalData > 0 ? ceil(fileTotalData / dataPerSample) : 0
totalAudioFrames = 1 + dataFrameCount

// 音频帧分配
audioSamples[0] = { isMeta: true, size: sample0_size }
for i in 1..dataFrameCount:
  rem = min(fileTotalData - (i-1) × dataPerSample, dataPerSample)
  audioSamples[i] = { size: rem }

// elst 循环次数
cover_dur = coverInfo.mdhd.duration
N_elst = ceil(audio_playback_dur / cover_playback_dur)
// 视频轨 stbl = 封面原始值（一份）
```

### 边界情况

- 空文件列表：`totalAudioFrames = 1`，仅帧 0（实际场景不出现）
- 空数据文件：`file.size = 0` 占一条 fileEntry，不影响数据帧
- 元数据超限：`sample0_size > bytesPerSample` 时抛错（帧 0 超出 1 个音频 sample 容量）

## ISOBMFF Box 构建

### 分轨 mvhd

mvhd 的 timescale 和 duration 需覆盖两条轨。取双轨中较大者：

```
timescale = max(vid_timescale, aud_timescale)
duration = max(vid_duration × timescale / vid_timescale,
               aud_duration × timescale / aud_timescale)
```

或简化：mvhd 各字段设为 0，实际时间线由各轨 mdhd 独立定义。推荐设 0 以避免循环视频的 duration 换算误差。

### 音频轨 stbl

all samples in single chunk（stsc 1 条 `N_audio samples → 1 chunk`），co64 退化为单条目常量。

```
stsz 条目 = 20 + 4 × N_audio
stsz[0] = sample0_size (精确)
stsz[i] = audioSamples[i].size (i > 0)
co64[0] = 音频轨数据起始偏移（视频轨数据总量 + mdat_header + ftyp + moov）
```

### 视频轨 stbl

封面原始值，不做修改。stsz/stts/stsc/stss 均为封面 MP4 中提取的原始数据。elst 负责循环播放，stbl 只描述一份封面帧。

## 编码流程

### Box 构建（预计算阶段）

```
audioSizes = [sample0_size, ...audioSample_sizes]

构建所有 box buffer:
  ftyp, mvhd
  trak[vide]: tkhd, edts→elst(N_elst条), mdhd, hdlr, vmhd, dref, stsd(avc1+avcC从封面复制), stts, stsc, stsz, stss, co64
  trak[soun]: tkhd, mdhd, hdlr, smhd, dref, stsd(sowt), stts, stsc, stsz, co64

  注: mdat 数据量 = 封面视频数据总量 + 音频轨数据总量
      视频轨 co64[0] = mdat_data_start
      音频轨 co64[0] = mdat_data_start + 封面视频数据总量
```

### 流式写入（ReadableStream 串行）

```
push(ftyp)
push(moov_hdr) → mvhd
push(trak_v_hdr) → tkhd → mdia → ... → stbl (所有视频 box)
push(trak_a_hdr) → tkhd → mdia → ... → stbl (所有音频 box)
push(mdat_hdr)

// ── 视频轨 data ──
for vf in coverFrames: push(vf.data)     // H.264 码流，只存一份
// ── 音频轨 data ──
push(28B 明文头)             // magic + encMagic + frameSalt + iter
push(AES-CTR 加密元数据)     // fileCount + fileEntries
for each data sample: push(AES-CTR 加密文件数据块)
closeStream()
```

## 解码流程

### 1. 解析双轨 MP4

```
parseMP4(blob):
  ftyp 验证
  遍历顶层 box → moov:
    遍历 trak:
      type='vide': 读 avcC, w, h, timescale, frame_count
      type='soun': 读 stsz (N_audio entries), co64 (基准偏移)
  遍历顶层 box → mdat: 记录数据起始偏移
```

### 2. 音频帧偏移

stsz 前缀和定位（与单轨 ISOBMFF 解码一致，仅在音频轨 stbl 中取 stsz + co64）：

```
audioBase = co64[0]
sampleOffsets[0] = audioBase
for i in 1..N-1:
  sampleOffsets[i] = sampleOffsets[i-1] + stsz[i-1]
```

### 3. 读帧 0 + 解密

```
buf = readBlob(blob, sampleOffsets[0], stsz[0])
magic = buf[0..3]  // assert 0x46495631
frameSalt = buf[8..23]
iter = buf[24..27]
encMagic = buf[4..7]

key = PBKDF2(password, frameSalt, iter)
验证: AES_DEC(encMagic, key, frameSalt, counter=0) == "FIV1"
解密加密区: decrypted = AES_DEC(buf[28..], key, frameSalt, counter=1)
解析: fileCount(BE 8B) + parseFileEntries(decrypted, 8, fileCount)
```

### 4. 提取文件数据

AES-CTR 流对齐解密，counter 从帧 0 解密结束处接续。逐帧读取音频轨 dataFrames 中的加密字节，对齐到 16 字节块边界解密。

末帧不足 16 字节对齐时，读到的 `blob.slice()` 返回短 buffer，需补零到 `ceil((prePad + len) / 16) × 16` 来解密（对应编码时 `padded` 缓冲区末尾的零填充）。

## 元数据分布

| 信息 | 存放位置 |
|---|---|
| 封面视频参数 | vide stsd (avcC, width, height) |
| 循环信息 | vide edts→elst（N_elst 条）|
| FIV1 魔数 | aud sample[0] 明文 0..3 |
| encMagic | aud sample[0] 明文 4..7 |
| frameSalt | aud sample[0] 明文 8..23 |
| 文件元数据 | aud sample[0] 加密区 |
| 音频帧偏移 | aud stsz 前缀和 + co64 |
| 文件数据 | aud sample[1..N] |

## 浏览器兼容性

| 浏览器 | avc1 | sowt | 预期 |
|---|---|---|---|
| Chrome | ✓ | 跳过 | 画面正常，无声，数据完整 |
| Edge | ✓ | 跳过 | 同 Chrome |
| Firefox | ✓ | 待测 | 跳过或控制台警告 |
| Safari | ✓ | 待测 | 可能拒绝文件 |

需实测 Firefox 和 Safari。若 Safari 因不识别 sowt 拒绝整个文件，退路是用静音 AAC 帧替代 PCM（AAC 最低码率下开销极小，约 1 KB/s）。

## 与封面原文件的差异

输出文件相对于原始封面 MP4：
- 视频帧内容不变，按需要循环延长
- 原音频轨（AAC/MP3）被移除
- 新增 sowt PCM 音频轨承载加密文件数据
- 视频轨 H.264 码流不做任何重编码
