import { apiError } from './lib.mjs';

/** A thin client for the Gilded Quill HTTP API, authenticated with a personal access token. */
export class QuillClient {
  constructor(baseUrl, token) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.token = token;
  }

  /** @returns {Promise<{status:number, body:any}>} (never throws for HTTP errors; throws for a missing token) */
  async request(method, path, body) {
    if (!this.token) throw new Error('QUILL_TOKEN is not set. Make an access token in the app (Profile → Security → Access tokens).');
    let res;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      return { status: 0, body: { error: String(e?.cause?.code ?? e?.message ?? e) } };
    }
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { error: text.slice(0, 200) };
    }
    return { status: res.status, body: parsed };
  }

  /** Like `request`, but throws a message for the model when the call did not succeed (2xx). */
  async ok(method, path, body, what) {
    const r = await this.request(method, path, body);
    if (r.status < 200 || r.status >= 300) throw new Error(apiError(r.status, r.body, what));
    return r;
  }
}

export const enc = (path) => path.split('/').map(encodeURIComponent).join('/');
