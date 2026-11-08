export { DefaultConfigurationService, configurationPoint } from './configuration-service.ts';
export { MAX_RECORDED_WRITES, memoryStorageBackend } from './memory-backend.ts';
export type { MemoryStorageBackend } from './memory-backend.ts';
export { persistenceModule } from './module.ts';
export { DefaultStorageService, LOAD_BACKOFF_MS, LOAD_TIMEOUT_MS, MAX_VALUE_BYTES, WRITE_DEBOUNCE_MS, WRITE_MAX_DELAY_MS, WRITE_RETRY_MS, WRITE_TIMEOUT_MS } from './storage-service.ts';
export type { StorageServiceOptions } from './storage-service.ts';
