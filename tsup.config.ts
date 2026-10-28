import { defineConfig, type Options } from 'tsup';

/**
 * ESM、CJS 与 IIFE 构建共享的输出选项
 * @description 三种产物的入口、目标与输出目录需保持一致，仅在格式与声明文件生成上分开。
 */
export const shared: Options = {
  entry: ['src/index.ts'],
  sourcemap: true,
  minify: false,
  splitting: false,
  target: 'es2019',
  platform: 'browser',
  outDir: 'dist'
};

export default defineConfig({
  ...shared,
  format: ['esm', 'cjs'],
  dts: true,
  // 清理由 `npm run build` 前置执行，避免多次 tsup 调用互相删除产物
  clean: false
});
