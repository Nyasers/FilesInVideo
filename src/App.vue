<template>
  <div class="app">
    <header class="header">
      <h1 class="title">FilesInVideo</h1>
      <span class="subtitle">把文件藏在视频的音频轨里</span>
    </header>

    <nav class="tabs">
      <button :class="['tab', { active: mode === 'encode' }]" @click="mode = 'encode'">编码</button>
      <button :class="['tab', { active: mode === 'decode' }]" @click="mode = 'decode'">解码</button>
    </nav>

    <main class="main">
      <section v-if="mode === 'encode'" class="panel">
        <div class="field">
          <label class="label">封面视频（MP4, H.264）</label>
          <FileInput accept="video/mp4" @select="onCoverSelect" />
          <p v-if="coverFile" class="hint">已选: {{ coverFile.name }}</p>
        </div>
        <div class="field">
          <label class="label">待隐藏文件</label>
          <FileInput multiple @select="onFilesSelect" />
          <ul v-if="encodeFiles.length" class="file-list">
            <li v-for="(f, i) in encodeFiles" :key="i">{{ f.name }} ({{ formatSize(f.size) }})</li>
          </ul>
        </div>
        <div class="field row">
          <div class="field-group">
            <label class="label">密码</label>
            <input v-model="encPassword" type="text" class="input" placeholder="可选，默认为空" />
          </div>
        </div>
        <div v-if="encoding" class="progress-wrap">
          <div v-if="encPhase === 'prep' || encPrepProgress >= 100" class="progress-row">
            <span class="progress-label">准备</span>
            <div class="progress-bar"><div class="progress-fill" :style="{ width: encPrepProgress + '%' }"></div></div>
            <span class="progress-pct">{{ encPrepProgress }}%</span>
          </div>
          <div v-if="encPhase === 'build'" class="progress-row">
            <span class="progress-label">编码</span>
            <div class="progress-bar"><div class="progress-fill" :style="{ width: encBuildProgress + '%' }"></div></div>
            <span class="progress-pct">{{ encBuildProgress }}%</span>
          </div>
          <div v-if="encPhase === 'build'" class="progress-row">
            <span class="progress-label">写盘</span>
            <div class="progress-bar"><div class="progress-fill" :style="{ width: encWriteProgress + '%' }"></div></div>
            <span class="progress-pct">{{ encWriteProgress }}%</span>
          </div>
        </div>
        <button class="btn primary" :disabled="!canEncode || encoding" @click="doEncode">
          {{ encoding ? '⏳' : '🎬 编码并下载' }}
        </button>
        <div v-if="encResult" class="result">
          <p>✅ 编码完成，{{ encResult.fileCount }} 个文件，共 {{ formatSize(encResult.totalDataSize) }}</p>
        </div>
        <div v-if="encError" class="error">{{ encError }}</div>
      </section>

      <section v-if="mode === 'decode'" class="panel">
        <div class="field">
          <label class="label">FIV 文件</label>
          <FileInput accept=".mp4,video/mp4" @select="onFivSelect" />
          <p v-if="fivFile" class="hint">已选: {{ fivFile.name }}</p>
        </div>
        <div class="field">
          <label class="label">密码</label>
          <input v-model="decPassword" type="text" class="input" placeholder="可选，默认为空" />
        </div>
        <button class="btn primary" :disabled="!canDecode || decoding" @click="doDecode">
          {{ decoding ? '⏳' : '🔓 解码到目录' }}
        </button>
        <div v-if="decoding" class="progress-wrap">
          <div class="progress-row">
            <span class="progress-label">总体</span>
            <div class="progress-bar"><div class="progress-fill" :style="{ width: decProgress + '%' }"></div></div>
            <span class="progress-pct">{{ decProgress }}%</span>
          </div>
          <div v-for="f in decFiles" :key="f.name" class="progress-row">
            <span class="progress-label">📄</span>
            <div class="progress-bar"><div class="progress-fill done" :style="{ width: f.done ? '100%' : '0%' }"></div></div>
            <span class="progress-pct">{{ f.done ? '✓' : '⏳' }}</span>
          </div>
        </div>
        <div v-if="decError" class="error">{{ decError }}</div>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import FileInput from './components/FileInput.vue';

const mode = ref<'encode' | 'decode'>('encode');

// ── Worker ──

let worker: Worker | null = null;
let writeHandle: FileSystemWritableFileStream | null = null;
let decDirHandle: FileSystemDirectoryHandle | null = null;
let decDoneFlag = false;
let decPendingWrites = 0;

function initWorker() {
  if (worker) return;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = onWorkerMsg;
}
function terminateWorker() { worker?.terminate(); worker = null; }
onMounted(initWorker);
onUnmounted(terminateWorker);

// ── Encode State ──

const coverFile = ref<File | null>(null);
const encodeFiles = ref<File[]>([]);
const encPassword = ref('');
const encResult = ref<{ fileCount: number; totalDataSize: number; audioFrames: number } | null>(null);
const encError = ref('');
const encoding = ref(false);
const progress = ref('');
const encPrepProgress = ref(0);
const encBuildProgress = ref(0);
const encWriteProgress = ref(0);
const encPhase = ref<'prep' | 'build'>('prep');
let encBytesWritten = 0;
const canEncode = computed(() => coverFile.value && encodeFiles.value.length > 0 && !encoding.value);

let encDoneFlag = false;
let encPendingChunks = 0;
let encFileCount = 0, encTotalSize = 0, encAudioFrames = 0;

function checkEncDone() {
  if (encDoneFlag && encPendingChunks === 0) {
    writeHandle?.close().then(() => {
      encResult.value = { fileCount: encFileCount, totalDataSize: encTotalSize, audioFrames: encAudioFrames };
    }).catch(() => {});
    writeHandle = null;
    encoding.value = false;
  }
}

// ── Decode State ──

const fivFile = ref<File | null>(null);
const decPassword = ref('');
const decError = ref('');
const decoding = ref(false);
const decProgress = ref(0);
const decPhase = ref('');
const decFiles = ref<{ name: string; size: number; done: boolean }[]>([]);
const canDecode = computed(() => fivFile.value && !decoding.value);

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function onCoverSelect(f: File) { coverFile.value = f; encResult.value = null; encError.value = ''; }
function onFilesSelect(fs: File[]) { encodeFiles.value = fs; encResult.value = null; encError.value = ''; }
function onFivSelect(f: File) { fivFile.value = f; decError.value = ''; }

async function safeWriteFile(dir: FileSystemDirectoryHandle, name: string, data: Uint8Array) {
  const dot = name.lastIndexOf('.');
  const stem = dot >= 0 ? name.slice(0, dot) : name;
  const ext = dot >= 0 ? name.slice(dot) : '';
  let tryName = name;
  for (let i = 1; i < 1000; i++) {
    try { await dir.getFileHandle(tryName, { create: false }); tryName = `${stem} (${i})${ext}`; }
    catch (e: any) { if (e.name === 'NotFoundError') break; throw e; }
  }
  const fh = await dir.getFileHandle(tryName, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

function checkDecDone() {
  if (decDoneFlag && decPendingWrites === 0) {
    decDirHandle = null;
    decoding.value = false;
  }
}

// ── Worker 消息处理 ──

function onWorkerMsg(e: MessageEvent) {
  const msg = e.data;
  if (!msg?.type) return;

  switch (msg.type) {
    // Encode
    case 'prep-progress':
      encPrepProgress.value = msg.pct;
      progress.value = msg.phase;
      break;
    case 'enc-progress':
      encBuildProgress.value = msg.pct;
      break;
    case 'enc-size':
      encTotalSize = msg.total;
      encPrepProgress.value = 100;
      encPhase.value = 'build';
      break;
    case 'header-size':
      encHeaderSize = msg.size;
      writeHandle!.write({ type: 'seek', position: encHeaderSize });
      break;
    case 'chunk':
      encPendingChunks++;
      const _buf2 = new Uint8Array(msg.data);
      const w = msg.pos != null
        ? writeHandle!.write({ type: 'write', position: msg.pos, data: _buf2 })
        : writeHandle!.write(_buf2);
      if (msg.pos == null) encMdatWritten += msg.size;
      w.finally(() => {
        encBytesWritten += msg.size;
        encWriteProgress.value = Math.round((encBytesWritten / encTotalSize) * 100);
        encPendingChunks--; checkEncDone();
      }).catch(() => {});
      break;
    case 'done':
      encFileCount = msg.fileCount;
      encTotalSize = msg.totalDataSize;
      encAudioFrames = msg.audioFrames;
      encDoneFlag = true;
      checkEncDone();
      break;
    // Decode
    case 'dec-progress':
      decProgress.value = msg.pct;
      decPhase.value = msg.phase;
      break;
    case 'dec-file-start':
      decFiles.value.push({ name: msg.name, size: msg.size, done: false });
      break;
    case 'dec-file':
      decPendingWrites++;
      safeWriteFile(decDirHandle!, msg.name, new Uint8Array(msg.data))
        .finally(() => {
          const entry = decFiles.value.find(f => f.name === msg.name && !f.done);
          if (entry) entry.done = true;
          decPendingWrites--;
          checkDecDone();
        })
        .catch(() => {});
      break;
    case 'dec-done':
      decDoneFlag = true;
      checkDecDone();
      break;
    // Shared
    case 'error':
      writeHandle?.close().catch(() => {});
      writeHandle = null;
      encDoneFlag = false;
      encPendingChunks = 0;
      encError.value = msg.error;
      encoding.value = false;
      break;
    case 'dec-error':
      decDirHandle = null;
      decDoneFlag = false;
      decPendingWrites = 0;
      decError.value = msg.error;
      decoding.value = false;
      break;
  }
}

// ── 编码 ──

async function doEncode() {
  if (!coverFile.value || encodeFiles.value.length === 0) return;
  encError.value = '';
  encResult.value = null;
  encoding.value = true;
  encPhase.value = 'prep';
  encPrepProgress.value = 0;
  encBuildProgress.value = 0;
  encWriteProgress.value = 0;
  encBytesWritten = 0;
  progress.value = '';
  encDoneFlag = false;
  encPendingChunks = 0;
  try {
    if (!('showSaveFilePicker' in window)) throw new Error('浏览器不支持，请使用 Chrome / Edge');
    const ext = '.fiv.mp4';
    const handle = await (window as any).showSaveFilePicker({
      suggestedName: (coverFile.value!.name || 'output').replace(/\.mp4$/i, '') + ext,
      types: [{ description: 'MP4 视频', accept: { 'video/mp4': ['.mp4'] } }],
    });
    writeHandle = await handle.createWritable();
    initWorker();
    worker!.postMessage({ type: 'encode', coverVideo: coverFile.value, files: [...encodeFiles.value], password: encPassword.value });
  } catch (e: any) {
    if (e.name !== 'AbortError') encError.value = e.message || String(e);
    writeHandle?.close().catch(() => {});
    writeHandle = null;
    encoding.value = false;
  }
}

// ── 解码 ──

async function doDecode() {
  if (!fivFile.value) return;
  decError.value = '';
  decoding.value = true;
  decProgress.value = 0;
  decPhase.value = '';
  decFiles.value = [];
  decDoneFlag = false;
  decPendingWrites = 0;
  try {
    if (!('showDirectoryPicker' in window)) throw new Error('浏览器不支持，请使用 Chrome / Edge');
    decDirHandle = await (window as any).showDirectoryPicker();
    initWorker();
    worker!.postMessage({ type: 'decode', blob: fivFile.value, password: decPassword.value });
  } catch (e: any) {
    if (e.name !== 'AbortError') decError.value = e.message || String(e);
    decoding.value = false;
  }
}
</script>
