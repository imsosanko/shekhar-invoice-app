/* Offline sync manager.
   Scope (deliberately, for reliability — see README "Offline sync" section):
   - GET responses are cached in IndexedDB and served when the network is down,
     so pages show last-known data instead of an error.
   - Edits to EXISTING records (update customer/product/expense/settings,
     record a payment, edit an invoice) made while offline are queued and
     replayed in order once the connection returns.
   - Creating NEW records (new invoice/customer/product/expense) requires a
     connection, since invoice numbers and IDs are assigned by the server —
     this is enforced by api.js throwing a clear error rather than queuing. */

const offlineSync = (() => {
  const listeners = [];
  let flushing = false;

  function notify() {
    idb.outboxAll().then(items => listeners.forEach(fn => fn({ online: navigator.onLine, pending: items.length })));
  }

  async function enqueue(method, path, body) {
    await idb.outboxAdd({ method, path, body });
    notify();
  }

  async function flush(rawRequestFn) {
    if (flushing || !navigator.onLine) return;
    flushing = true;
    try {
      let items = await idb.outboxAll();
      items = items.sort((a, b) => a.id - b.id);
      for (const item of items) {
        try {
          await rawRequestFn(item.method, item.path, item.body);
          await idb.outboxDelete(item.id);
        } catch (e) {
          break; // stop here to preserve order; remaining items retry next time
        }
      }
    } finally {
      flushing = false;
      notify();
    }
  }

  function init(rawRequestFn) {
    window.addEventListener('online', () => { notify(); flush(rawRequestFn); });
    window.addEventListener('offline', notify);
    // Also try periodically in case the 'online' event doesn't fire reliably
    // (some browsers/OSes are inconsistent about it).
    setInterval(() => { if (navigator.onLine) flush(rawRequestFn); }, 20000);
    notify();
  }

  return {
    init,
    enqueue,
    onStatusChange(fn) { listeners.push(fn); },
    async pendingCount() { return (await idb.outboxAll()).length; },
    isOnline: () => navigator.onLine
  };
})();
