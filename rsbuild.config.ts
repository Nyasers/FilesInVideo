import { defineConfig } from '@rsbuild/core';
import { pluginVue } from '@rsbuild/plugin-vue';

export default defineConfig({
  plugins: [pluginVue()],
  source: {
    entry: { index: './src/index.ts' },
  },
  html: {
    template: './src/index.html',
  },
  output: {
    distPath: { root: 'dist', js: '' },
    cleanDistPath: true,
    filename: {
      js: 'static/js/[name].[contenthash:8].js',
    },
  },
});
