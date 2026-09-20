// Thin fetch wrapper: attaches the JWT, parses JSON, and throws readable errors
// so page code can just `await api.get(...)` / `await api.post(...)`.
// Also integrates offline support (see offline.js): GET responses are cached
// and served when the network is down; edits to existing records are queued
// and replayed automatically once the connection returns.

const api = (() => {
  const TOKEN_KEY = 'shekhar_token';

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || null;
  }
  function setToken(token, remember) {
    clearToken();
    if (!token) return;
    (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
  }
  function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  }

  function isNetworkError(e) {
    // A real "no connection" failure throws a TypeError from fetch() itself,
    // as opposed to a resolved response with a 4xx/5xx status.
    return e instanceof TypeError;
  }

  /** The actual network call, with no offline fallback — used both for live
   *  requests and for replaying queued items once back online. */
  async function rawRequest(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const res = await fetch('/api' + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });

    if (res.status === 401) {
      clearToken();
      if (window.onSessionExpired) window.onSessionExpired();
      throw new Error('Session expired. Please sign in again.');
    }

    let data = null;
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); } catch (e) { data = null; }
    }
    if (!res.ok) {
      throw new Error((data && data.error) || `Request failed (${res.status})`);
    }
    return data;
  }

  async function request(method, path, body) {
    if (method === 'GET') {
      try {
        const data = await rawRequest('GET', path);
        if (typeof idb !== 'undefined') idb.cacheSet(path, data);
        return data;
      } catch (e) {
        if (isNetworkError(e) && typeof idb !== 'undefined') {
          const cached = await idb.cacheGet(path);
          if (cached) return { ...cached.data, _offline: true, _cachedAt: cached.cachedAt };
        }
        throw e;
      }
    }

    try {
      return await rawRequest(method, path, body);
    } catch (e) {
      if (!isNetworkError(e)) throw e; // real validation/server error — surface it as-is
      if (method === 'POST') {
        throw new Error('You\u2019re offline. Creating new records needs an internet connection — try again once you\u2019re back online.');
      }
      // PUT/DELETE on an existing record: queue it and let the UI proceed optimistically.
      await offlineSync.enqueue(method, path, body);
      return { ok: true, ...body, _pendingSync: true };
    }
  }

  /** Fetches a binary file (PDF/Excel) as a Blob, with auth header attached.
   *  No offline fallback — PDFs/Excel exports are generated server-side by
   *  Python and can't be produced without a connection. */
  async function getBlob(path) {
    const headers = {};
    const token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch('/api' + path, { headers });
    if (res.status === 401) {
      clearToken();
      if (window.onSessionExpired) window.onSessionExpired();
      throw new Error('Session expired. Please sign in again.');
    }
    if (!res.ok) {
      let msg = `Request failed (${res.status})`;
      try { const j = await res.json(); if (j.error) msg = j.error; } catch (e) {}
      throw new Error(msg);
    }
    return res.blob();
  }

  return {
    getToken, setToken, clearToken, rawRequest,
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    put: (path, body) => request('PUT', path, body),
    del: (path) => request('DELETE', path),
    getBlob
  };
})();
