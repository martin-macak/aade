import { storageBackendConformance } from '@tessera/testing';
import { memoryStorageBackend } from '@tessera/persistence';

storageBackendConformance('memoryStorageBackend', () => {
  const backend = memoryStorageBackend();
  return { backend, writeExternally: (scope, batch) => backend.writeExternally(scope, batch), dispose: () => backend.dispose() };
});
