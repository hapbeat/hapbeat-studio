// vitest setup — runs before each test module imports.
//
// We test pure logic in the lightweight 'node' environment (no jsdom), but a
// few modules probe `window` at import time (e.g. libraryStore's Zustand store
// init calls isFileSystemAccessSupported() → window.showDirectoryPicker). Give
// them a minimal `window` stub so importing the module doesn't throw; the probe
// just resolves falsy (File System Access "unsupported"), which is correct for
// a headless test run.
if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
  ;(globalThis as { window?: unknown }).window = globalThis as unknown
}
