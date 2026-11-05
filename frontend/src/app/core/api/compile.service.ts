import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface Diagnostic {
  severity: 'error' | 'warning' | string;
  file: string | null;
  line: number | null;
  message: string;
}

export interface CompileResponse {
  ok: boolean;
  pdfUrl: string | null;
  log: string;
  diagnostics: Diagnostic[];
  durationMs: number;
  builtAt: number;
}

export type CompileState = 'idle' | 'compiling' | 'ok' | 'failed';

/** Everything another window needs to draw the ink log and the preview. */
export interface CompileSnapshot {
  state: CompileState;
  result: CompileResponse | null;
  fatalError: string | null;
  pdfUrl: string | null;
  pdfBuiltAt: number | null;
}

/** Talks to the Rust compile endpoint and keeps the last good PDF around when a build fails. */
@Injectable({ providedIn: 'root' })
export class CompileService {
  private readonly http = inject(HttpClient);

  readonly state = signal<CompileState>('idle');
  readonly result = signal<CompileResponse | null>(null);
  /** The most recent *successful* PDF, so the preview stays useful while the source is broken. */
  readonly pdfUrl = signal<string | null>(null);
  readonly pdfBuiltAt = signal<number | null>(null);
  /** Transport/engine failure that produced no structured result (e.g. engine not installed). */
  readonly fatalError = signal<string | null>(null);

  readonly errors = computed(() => (this.result()?.diagnostics ?? []).filter((d) => d.severity === 'error'));
  readonly warnings = computed(() => (this.result()?.diagnostics ?? []).filter((d) => d.severity === 'warning'));
  /** True when the preview shows an older build than the latest (failed) attempt. */
  readonly stale = computed(() => this.state() === 'failed' && this.pdfUrl() !== null);

  snapshot(): CompileSnapshot {
    return { state: this.state(), result: this.result(), fatalError: this.fatalError(), pdfUrl: this.pdfUrl(), pdfBuiltAt: this.pdfBuiltAt() };
  }

  /** Mirror the main window's compile state (used by popped-out panels). */
  applyRemote(s: CompileSnapshot): void {
    this.state.set(s.state);
    this.result.set(s.result);
    this.fatalError.set(s.fatalError);
    // a PDF address is only ever one of our own: ignore anything else another page might claim
    this.pdfUrl.set(s.pdfUrl && s.pdfUrl.startsWith('/api/rooms/') ? s.pdfUrl : this.pdfUrl());
    this.pdfBuiltAt.set(s.pdfBuiltAt);
  }

  /** Show a PDF that another scribe just built (announced through the document). */
  adoptBuild(room: string, builtAt: number): void {
    if (this.pdfBuiltAt() === builtAt) return;
    this.pdfUrl.set(`/api/rooms/${encodeURIComponent(room)}/pdf?v=${builtAt}`);
    this.pdfBuiltAt.set(builtAt);
  }

  /** `source` is the file to compile (the one selected in the editor); without it the scroll's main file is used. */
  async compile(room: string, source?: string | null): Promise<void> {
    if (this.state() === 'compiling') return;
    this.state.set('compiling');
    this.fatalError.set(null);
    try {
      const res = await firstValueFrom(this.http.post<CompileResponse>(`/api/rooms/${encodeURIComponent(room)}/compile`, source ? { main: source } : {}));
      this.result.set(res);
      if (res.ok && res.pdfUrl) {
        this.pdfUrl.set(res.pdfUrl);
        this.pdfBuiltAt.set(res.builtAt);
      }
      this.state.set(res.ok ? 'ok' : 'failed');
    } catch (e) {
      const err = e as HttpErrorResponse;
      this.result.set(null);
      this.fatalError.set(err.error?.error ?? err.message ?? 'The compiler could not be reached.');
      this.state.set('failed');
    }
  }
}
