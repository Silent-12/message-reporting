import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs', 'iife'],
  globalName: 'MessageReportingSDK',
  dts: true,
  clean: true,
  sourcemap: true,
  minify: false,
  splitting: false,
  target: 'es2019',
  platform: 'browser',
  outDir: 'dist'
});
