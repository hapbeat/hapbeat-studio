/// <reference types="vite/client" />

/** Build metadata injected by vite.config.ts via `process.env.VITE_*`. */
interface ImportMetaEnv {
  readonly VITE_BUILD_SHA: string
  readonly VITE_BUILD_DATE: string
  /** Human-facing semver (from release tag or package.json). */
  readonly VITE_APP_VERSION: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
