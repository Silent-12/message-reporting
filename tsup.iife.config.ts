import { defineConfig } from 'tsup';
import { shared } from './tsup.config';

/**
 * IIFE 构建配置
 * @description 与 ESM/CJS 分开执行：tsup 在 IIFE 与 dts 同时生成时会并发写入同一批声明文件，
 * 触发 EPERM 导致构建失败；IIFE 不需要类型声明，因此独立构建且关闭 dts。
 */
export default defineConfig({
  ...shared,
  format: ['iife'],
  globalName: 'MessageReportingSDK',
  dts: false,
  clean: false
});
