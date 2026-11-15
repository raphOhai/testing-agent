// A small fetch wrapper. Each fake user gets their own client (their own token/cookies).
// Every URL is checked by the staging guard before the request leaves the machine.

export class HttpError extends Error {
  constructor(method, url, status, body) {
    const snippet = typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body)?.slice(0, 300);
    super(`${method} ${new URL(url).pathname} → ${status}${snippet ? `: ${snippet}` : ''}`);
    this.status = status;
    this.body = body;
  }
}

export function createHttp({ baseUrl, guard, timeoutMs = 30000, headers = {} }) {
  const state = { headers: { ...headers }, cookies: new Map() };

  async function request(method, pathOrUrl, { body, form, query, headers: extra = {}, expect, raw, timeout } = {}) {
    const url = new URL(pathOrUrl, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    if (/^\//.test(pathOrUrl)) {
      // Keep any base path (e.g. https://host/api) when a path starts with "/".
      const base = new URL(baseUrl);
      url.pathname = base.pathname.replace(/\/$/, '') + pathOrUrl.split('?')[0];
      const qs = pathOrUrl.split('?')[1];
      if (qs) url.search = qs;
    }
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined) url.searchParams.set(k, v);
    guard.assertUrl(url.toString());

    const h = { accept: 'application/json, text/plain, */*', ...state.headers, ...extra };
    if (state.cookies.size) h.cookie = [...state.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload;
    if (form) { payload = new URLSearchParams(form).toString(); h['content-type'] = 'application/x-www-form-urlencoded'; }
    else if (body !== undefined) { payload = typeof body === 'string' ? body : JSON.stringify(body); h['content-type'] ??= 'application/json'; }

    const res = await fetch(url, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(timeout || timeoutMs) });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) state.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    if (raw) return res;
    const text = await res.text();
    let data = text;
    if ((res.headers.get('content-type') || '').includes('json') && text) { try { data = JSON.parse(text); } catch { /* keep text */ } }
    const ok = expect ? [].concat(expect).includes(res.status) : res.status < 400;
    if (!ok) throw new HttpError(method, url.toString(), res.status, data);
    return data;
  }

  return {
    request,
    get: (p, o) => request('GET', p, o),
    delete: (p, o) => request('DELETE', p, o),
    post: (p, body, o) => request('POST', p, { ...o, body }),
    put: (p, body, o) => request('PUT', p, { ...o, body }),
    patch: (p, body, o) => request('PATCH', p, { ...o, body }),
    setToken(token, scheme = 'Bearer') { state.headers.authorization = scheme ? `${scheme} ${token}` : token; },
    setHeader(k, v) { if (v === undefined) delete state.headers[k]; else state.headers[k] = v; },
    get cookies() { return state.cookies; },
  };
}
