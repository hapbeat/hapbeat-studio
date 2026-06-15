import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// Studio の回帰テスト設定。純ロジック (純関数) のユニットテストに絞るため
// environment は 'node'（jsdom 不要）。`@/*` alias は vite.config.ts と
// tsconfig paths に合わせる。
export default defineConfig({
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    // 一部モジュールが import 時に window を参照するため最小 stub を先に注入
    // (jsdom 非依存で純ロジックテストを回す)。
    setupFiles: ['./src/test-setup.ts'],
  },
})
