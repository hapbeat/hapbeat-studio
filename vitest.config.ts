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
  },
})
