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

  /**
   * Send or fetch raw bytes (pictures). `body` is a Buffer to send, or undefined to download.
   * @returns {Promise<{status:number, body:any, bytes?:Buffer, mime?:string}>} JSON `body` for uploads and errors, `bytes` for a download.
   */
  async binary(method, path, body) {
    if (!this.token) throw new Error('QUILL_TOKEN is not set. Make an access token in the app (Profile → Security → Access tokens).');
    let res;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': 'application/octet-stream' }) },
        body,
      });
    } catch (e) {
      return { status: 0, body: { error: String(e?.cause?.code ?? e?.message ?? e) } };
    }
    if (res.ok && method === 'GET') return { status: res.status, body: null, bytes: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type') || '' };
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { error: text.slice(0, 200) };
    }
    return { status: res.status, body: parsed };
  }

  /** Like `binary`, but throws a message for the model when the call did not succeed. */
  async okBinary(method, path, body, what) {
    const r = await this.binary(method, path, body);
    if (r.status < 200 || r.status >= 300) throw new Error(apiError(r.status, r.body, what));
    return r;
  }

  /** Like `request`, but throws a message for the model when the call did not succeed (2xx). */
  async ok(method, path, body, what) {
    const r = await this.request(method, path, body);
    if (r.status < 200 || r.status >= 300) throw new Error(apiError(r.status, r.body, what));
    return r;
  }
}

export const enc = (path) => path.split('/').map(encodeURIComponent).join('/');
