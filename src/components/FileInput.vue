<template>
  <label class="file-input">
    <input
      type="file"
      :accept="accept"
      :multiple="multiple"
      :webkitdirectory="directory"
      @change="onChange"
      hidden
      ref="inputRef"
    />
    <span class="drop-zone">
      <slot>{{ placeholder }}</slot>
    </span>
  </label>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';

const props = withDefaults(defineProps<{
  accept?: string;
  multiple?: boolean;
  directory?: boolean;
  placeholder?: string;
}>(), {
  placeholder: '点击选择文件',
});

const emit = defineEmits<{
  select: [files: File | File[]];
}>();

const inputRef = ref<HTMLInputElement>();

function onChange(e: Event) {
  const target = e.target as HTMLInputElement;
  const files = Array.from(target.files ?? []);
  if (!files.length) return;

  if (props.multiple || props.directory) {
    emit('select', files);
  } else {
    emit('select', files[0]);
  }

  // reset so same file can be re-selected
  if (inputRef.value) inputRef.value.value = '';
}
</script>
