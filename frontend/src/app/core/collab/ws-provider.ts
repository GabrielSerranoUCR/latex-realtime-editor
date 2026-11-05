import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { BehaviorSubject, Subscription, timer } from 'rxjs';
import { webSocket, WebSocketSubject } from 'rxjs/webSocket';
import * as Y from 'yjs';

// Message tags of the y-sync wire protocol (shared with the Rust server / yrs).
const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_AUTH = 2;
const MSG_QUERY_AWARENESS = 3;

export type ConnectionStatus = 'connecting' | 'connected' | 'offline';

export interface WsProviderOptions {
  /** Base delay of the reconnect back-off, in ms. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Custom WebSocket implementation (tests, or non-browser clients that must send a cookie). */
  webSocketCtor?: typeof WebSocket;
}

/**
 * Binds a Y.Doc and its Awareness to a y-sync WebSocket, managed with RxJS.
 *
 * - Local edits are streamed as `Update` messages; remote ones are applied with `this` as the
 *   transaction origin so they are never echoed back.
 * - When the socket drops, edits keep applying locally. On reconnect the handshake
 *   (SyncStep1/SyncStep2) exchanges whatever each side is missing, so offline edits merge.
 */
export class WsProvider {
  readonly status$ = new BehaviorSubject<ConnectionStatus>('connecting');
  /** True once the server's state has been received at least once since the last connect. */
  readonly synced$ = new BehaviorSubject<boolean>(false);

  private socket?: WebSocketSubject<Uint8Array>;
  private sub?: Subscription;
  private retry?: Subscription;
  private attempts = 0;
  private destroyed = false;
  private isOpen = false;

  constructor(
    private readonly url: string,
    readonly doc: Y.Doc,
    readonly awareness: awarenessProtocol.Awareness,
    private readonly opts: WsProviderOptions = {},
  ) {
    doc.on('update', this.onDocUpdate);
    awareness.on('update', this.onAwarenessUpdate);
    if (typeof window !== 'undefined') window.addEventListener('beforeunload', this.onUnload);
    this.open();
  }

  get connected(): boolean {
    return this.status$.value === 'connected';
  }

  destroy(): void {
    this.destroyed = true;
    this.retry?.unsubscribe();
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', this.onUnload);
    this.doc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwarenessUpdate);
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'destroy');
    this.sub?.unsubscribe();
    this.socket?.complete();
    this.status$.next('offline');
    this.status$.complete();
    this.synced$.complete();
  }

  // ---- connection lifecycle -------------------------------------------------------------

  private open(): void {
    if (this.destroyed) return;
    this.status$.next(this.attempts === 0 ? 'connecting' : 'offline');
    this.isOpen = false;
    const socket = webSocket<Uint8Array>({
      url: this.url,
      binaryType: 'arraybuffer',
      serializer: (v) => v as never,
      deserializer: (e) => new Uint8Array(e.data as ArrayBuffer),
      openObserver: { next: () => this.onOpen() },
      ...(this.opts.webSocketCtor ? { WebSocketCtor: this.opts.webSocketCtor } : {}),
    });
    this.socket = socket;
    this.sub = socket.subscribe({
      next: (data) => this.onMessage(data),
      error: () => this.onClosed(),
      complete: () => this.onClosed(),
    });
  }

  private onOpen(): void {
    this.attempts = 0;
    this.isOpen = true;
    this.status$.next('connected');
    // Ask for what we lack...
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    this.send(encoding.toUint8Array(enc));
    // ...and announce ourselves.
    if (this.awareness.getLocalState() !== null) {
      this.send(this.encodeAwareness([this.doc.clientID]));
    }
  }

  private onClosed(): void {
    if (this.destroyed || !this.isOpen && this.retry && !this.retry.closed) return;
    this.isOpen = false;
    this.synced$.next(false);
    this.status$.next('offline');
    // Presence of everyone else is stale while we are disconnected.
    const others = Array.from(this.awareness.getStates().keys()).filter((id) => id !== this.doc.clientID);
    awarenessProtocol.removeAwarenessStates(this.awareness, others, this);
    this.sub?.unsubscribe();

    const min = this.opts.minBackoffMs ?? 500;
    const max = this.opts.maxBackoffMs ?? 10_000;
    const delay = Math.min(max, min * 2 ** this.attempts) * (0.75 + Math.random() * 0.5);
    this.attempts++;
    this.retry = timer(delay).subscribe(() => this.open());
  }

  // ---- protocol -------------------------------------------------------------------------

  private onMessage(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    // A single frame can carry several messages (the server greets with SyncStep1 + awareness).
    while (decoding.hasContent(decoder)) {
      const type = decoding.readVarUint(decoder);
      switch (type) {
        case MSG_SYNC: {
          const reply = encoding.createEncoder();
          encoding.writeVarUint(reply, MSG_SYNC);
          const kind = syncProtocol.readSyncMessage(decoder, reply, this.doc, this);
          if (kind === syncProtocol.messageYjsSyncStep2 && !this.synced$.value) this.synced$.next(true);
          if (encoding.length(reply) > 1) this.send(encoding.toUint8Array(reply));
          break;
        }
        case MSG_AWARENESS:
          awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
          break;
        case MSG_QUERY_AWARENESS:
          this.send(this.encodeAwareness(Array.from(this.awareness.getStates().keys())));
          break;
        case MSG_AUTH: {
          const granted = decoding.readVarUint(decoder) === 1;
          if (!granted) console.warn('[collab] permission denied:', decoding.readVarString(decoder));
          break;
        }
        default:
          console.warn('[collab] unknown message type', type);
          return;
      }
    }
  }

  private encodeAwareness(clients: number[]): Uint8Array {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients));
    return encoding.toUint8Array(enc);
  }

  private send(bytes: Uint8Array): void {
    if (this.isOpen) this.socket?.next(bytes);
  }

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    this.send(encoding.toUint8Array(enc));
  };

  private readonly onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === this) return;
    this.send(this.encodeAwareness([...added, ...updated, ...removed]));
  };

  private readonly onUnload = (): void => {
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], 'window unload');
  };
}
