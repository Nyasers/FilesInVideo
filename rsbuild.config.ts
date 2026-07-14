import { defineConfig } from '@rsbuild/core';
import { pluginVue } from '@rsbuild/plugin-vue';
import { existsSync, unlinkSync } from 'fs';

export default defineConfig({
  plugins: [
    pluginVue(),
    {
      name: 'fiv-sw',
      setup(api) {
        api.onAfterBuild(() => {
          if (existsSync('dist/sw.html')) unlinkSync('dist/sw.html');
        });
      },
    },
  ],
  source: {
    entry: { index: './src/index.ts', sw: './src/sw.ts' },
  },
  html: {
    template: './src/index.html',
  },
  output: {
    distPath: { root: 'dist', js: '' },
    cleanDistPath: true,
    filename: {
      js: (pathData) => {
        if (pathData.chunk?.name === 'sw') return 'sw.js';
        return 'static/js/[name].[contenthash:8].js';
      },
    },
  },
});
