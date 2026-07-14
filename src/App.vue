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
          <div class="progress-bar"><div class="progress-fill" :style="{ width: encProgress + '%' }"></div></div>
          <p class="progress-text">{{ progress || '准备中…' }}</p>
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
          <div class="progress-bar"><div class="progress-fill" :style="{ width: decProgress + '%' }"></div></div>
          <p class="progress-text">{{ decPhase || '解码中…' }}</p>
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
const encProgress = ref(0);
const canEncode = computed(() => coverFile.value && encodeFiles.value.length > 0 && !encoding.value);

// ── Decode State ──

const fivFile = ref<File | null>(null);
const decPassword = ref('');
const decError = ref('');
const decoding = ref(false);
const decProgress = ref(0);
const decPhase = ref('');
const canDecode = computed(() => fivFile.value && !decoding.value);

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function onCoverSelect(f: File) { coverFile.value = f; encResult.value = null; encError.value = ''; }
function onFilesSelect(fs: File[]) { encodeFiles.value = fs; encResult.value = null; encError.value = ''; }
function onFivSelect(f: File) { fivFile.value = f; decError.value = ''; }

// ── Worker 消息处理 ──

function onWorkerMsg(e: MessageEvent) {
  const msg = e.data;
  if (!msg?.type) return;

  switch (msg.type) {
    // Encode
    case 'progress':
      encProgress.value = msg.pct;
      progress.value = msg.phase;
      break;
    case 'chunk':
      writeHandle?.write(new Uint8Array(msg.data)).catch(() => {});
      break;
    case 'done':
      writeHandle?.close().then(() => {
        encResult.value = {
          fileCount: msg.fileCount,
          totalDataSize: msg.totalDataSize,
          audioFrames: msg.audioFrames,
        };
      }).catch(() => {});
      writeHandle = null;
      encoding.value = false;
      break;
    // Decode
    case 'dec-progress':
      decProgress.value = msg.pct;
      decPhase.value = msg.phase;
      break;
    case 'dec-file':
      decDirHandle?.getFileHandle(msg.name, { create: true }).then(async (fh) => {
        const w = await fh.createWritable();
        await w.write(new Uint8Array(msg.data));
        await w.close();
      }).catch(() => {});
      break;
    case 'dec-done':
      decDirHandle = null;
      decoding.value = false;
      break;
    // Shared
    case 'error':
      writeHandle?.close().catch(() => {});
      writeHandle = null;
      encError.value = msg.error;
      encoding.value = false;
      break;
    case 'dec-error':
      decDirHandle = null;
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
  encProgress.value = 0;
  progress.value = '';
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
