import { Injectable, signal } from '@angular/core';

export type ToastKind = 'info' | 'ok' | 'bad';

export interface Toast {
  id: number;
  text: string;
  kind: ToastKind;
  /** A button on the message: it runs, and the message goes away. */
  action?: { label: string; run: () => void };
}

/** Short messages that appear over whatever page you are on and go away by themselves. */
@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);
  private nextId = 1;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  show(text: string, kind: ToastKind = 'info', ms = kind === 'bad' ? 8000 : 5000, action?: Toast['action']): number {
    const id = this.nextId++;
    // never a pile: the oldest makes way
    this.toasts.update((l) => [...l.slice(-3), { id, text, kind, action }]);
    this.timers.set(id, setTimeout(() => this.dismiss(id), ms));
    return id;
  }

  dismiss(id: number): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.toasts.update((l) => l.filter((t) => t.id !== id));
  }
}
