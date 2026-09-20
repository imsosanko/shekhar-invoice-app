/* Minimal promise-based IndexedDB wrapper — two object stores:
   - "cache":  last-known-good GET responses, keyed by API path, so pages
               can render something useful while offline.
   - "outbox": queued mutations (edits to existing records, payments,
               settings changes) made while offline, replayed in order
               once the connection comes back. */

const idb = (() => {
  const DB_NAME = 'shekhar-offline';
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('cache')) db.createObjectStore('cache', { keyPath: 'path' });
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(storeName, mode) {
    const db = await open();
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  return {
    async cacheSet(path, data) {
      const store = await tx('cache', 'readwrite');
      store.put({ path, data, cachedAt: Date.now() });
    },
    async cacheGet(path) {
      const store = await tx('cache', 'readonly');
      return new Promise(resolve => {
        const req = store.get(path);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    },
    async outboxAdd(item) {
      const store = await tx('outbox', 'readwrite');
      return new Promise((resolve, reject) => {
        const req = store.add({ ...item, createdAt: Date.now() });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },
    async outboxAll() {
      const store = await tx('outbox', 'readonly');
      return new Promise(resolve => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    },
    async outboxDelete(id) {
      const store = await tx('outbox', 'readwrite');
      store.delete(id);
    }
  };
})();
