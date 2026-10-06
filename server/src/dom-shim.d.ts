// src/data/mock/seed.ts only needs `import type { Persisted } from './storage'`, but tsc still checks
// storage.ts, which touches browser globals. Declared loosely here so the server stays free of the DOM lib.
declare const window: any
declare type StorageEvent = any
