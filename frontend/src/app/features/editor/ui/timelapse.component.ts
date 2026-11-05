import { Component, DestroyRef, ElementRef, HostListener, computed, inject, signal, viewChild } from '@angular/core';
import { Replayer, SPEEDS, Session, autoSpeed, clock } from '../../../core/session/session';
import { windowLines } from '../../../core/session/view';

/** Lines of the file drawn at once: enough to read, small enough to fit above the controls on a laptop. */
const LINES_SHOWN = 24;

/**
 * The timelapse: watch how a recorded session's text was written, sped up. Pauses are cut short, the file being
 * edited is shown with the text just typed lit up, and you can pause, change the speed and scrub.
 */
@Component({
  selector: 'qq-timelapse',
  template: `
    <dialog class="modal" #dlg aria-labelledby="tlH" (close)="stop()" (cancel)="stop()">
      <div class="parchment box">
        @if (replayer(); as r) {
          <header>
            <div class="ttl">
              <h2 id="tlH">Timelapse · {{ r.session.title }}</h2>
              <p class="lede">{{ info() }}</p>
            </div>
            <button class="x" type="button" aria-label="Close" (click)="close()">✕</button>
          </header>

          <div class="tabs" role="tablist" aria-label="Files">
            @for (f of fileList(); track f) {
              <button type="button" role="tab" [class.on]="f === shown()" [attr.aria-selected]="f === shown()" (click)="pick(f)">{{ f }}</button>
            }
            @if (!fileList().length) { <span class="none">No files yet</span> }
          </div>

          <div class="code" tabindex="0" role="img" [attr.aria-label]="'The text of ' + (shown() ?? 'the scroll') + ' as it was written'">
            @for (l of view().lines; track l.n) {
              <div class="row"><span class="ln">{{ l.n }}</span>@for (s of l.segs; track $index) {@if (s.mark) {<mark>{{ s.text }}</mark>} @else {<span>{{ s.text }}</span>}}</div>
            }
          </div>
          <p class="more" aria-hidden="true">{{ view().totalLines }} {{ view().totalLines === 1 ? 'line' : 'lines' }}{{ ended() ? ' · the end' : '' }}</p>

          <div class="bar">
            <button type="button" class="btn btn--sm" (click)="toggle()" [attr.aria-label]="playing() ? 'Pause' : 'Play'">{{ playing() ? '⏸ Pause' : ended() ? '↺ Again' : '▶ Play' }}</button>
            <input type="range" min="0" [max]="r.total" step="1" [value]="vt()" aria-label="Position in the timelapse" (input)="scrub($any($event.target).value)" />
            <span class="clock" aria-live="off">{{ at() }} / {{ whole() }}</span>
            <label class="speed"><span>Speed</span>
              <select aria-label="Playback speed" [value]="speed()" (change)="setSpeed($any($event.target).value)">
                <option value="auto">Auto ({{ auto() }}×)</option>
                @for (s of speeds; track s) { <option [value]="s">{{ s }}×</option> }
              </select>
            </label>
          </div>
        }
      </div>
    </dialog>
  `,
  styleUrl: './timelapse.component.scss',
})
export class TimelapseComponent {
  private readonly dlg = viewChild.required<ElementRef<HTMLDialogElement>>('dlg');

  protected readonly speeds = SPEEDS;
  protected readonly replayer = signal<Replayer | null>(null);
  protected readonly playing = signal(false);
  /** Where we are on the timelapse's own clock (long pauses already cut). */
  protected readonly vt = signal(0);
  /** Bumped each time edits are applied, so the view looks again. */
  private readonly rev = signal(0);
  protected readonly speed = signal<string>('auto');
  /** The file shown: the one being edited, unless the viewer picked another. */
  private readonly pinned = signal<string | null>(null);
  private readonly focusFile = signal<string | null>(null);
  private readonly lastEdit = signal<{ pos: number; len: number } | null>(null);
  private frame = 0;
  private last = 0;

  constructor() {
    inject(DestroyRef).onDestroy(() => cancelAnimationFrame(this.frame));
  }

  protected readonly auto = computed(() => autoSpeed(this.replayer()?.total ?? 0));
  protected readonly rate = computed(() => (this.speed() === 'auto' ? this.auto() : Number(this.speed())));
  protected readonly ended = computed(() => !!this.replayer() && this.vt() >= this.replayer()!.total);
  protected readonly fileList = computed(() => {
    this.rev();
    return [...(this.replayer()?.texts.keys() ?? [])].sort();
  });
  protected readonly shown = computed(() => {
    const files = this.fileList();
    const want = this.pinned() ?? this.focusFile();
    return want && files.includes(want) ? want : (files[0] ?? null);
  });
  protected readonly view = computed(() => {
    this.rev();
    const file = this.shown();
    const text = (file && this.replayer()?.texts.get(file)) || '';
    const edit = this.lastEdit();
    const focus = edit && file === this.focusFile() ? edit.pos + edit.len : 0;
    return windowLines(text, focus, edit && file === this.focusFile() && edit.len ? { from: edit.pos, to: edit.pos + edit.len } : null, LINES_SHOWN);
  });
  protected readonly at = computed(() => clock(this.vt() / 1));
  protected readonly whole = computed(() => clock(this.replayer()?.total ?? 0));
  protected readonly info = computed(() => {
    const s: Session | undefined = this.replayer()?.session;
    if (!s) return '';
    const when = new Date(s.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const n = s.ops.length;
    return `Recorded ${when} · ${clock(s.durationMs)} of writing · ${n} ${n === 1 ? 'edit' : 'edits'} · ${this.rate() === 1 ? 'plays in real time' : `plays ${this.rate()}× faster`}`;
  });

  /** Open a recording and begin playing it. */
  open(session: Session): void {
    this.stop();
    const r = new Replayer(session);
    this.replayer.set(r);
    this.pinned.set(null);
    this.focusFile.set(null);
    this.lastEdit.set(null);
    this.speed.set('auto');
    this.vt.set(0);
    this.rev.update((n) => n + 1);
    if (!this.dlg().nativeElement.open) this.dlg().nativeElement.showModal();
    this.play();
  }

  protected close(): void {
    this.dlg().nativeElement.close();
  }

  protected stop(): void {
    this.playing.set(false);
    cancelAnimationFrame(this.frame);
  }

  private play(): void {
    const r = this.replayer();
    if (!r) return;
    if (this.ended()) this.scrub(0);
    this.playing.set(true);
    this.last = performance.now();
    const step = (now: number) => {
      if (!this.playing()) return;
      const dt = Math.min(100, now - this.last); // a stalled tab does not jump ahead
      this.last = now;
      const to = Math.min(r.total, this.vt() + dt * this.rate());
      this.vt.set(to);
      this.show(r.advanceTo(to));
      if (to >= r.total) this.playing.set(false);
      else this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }

  /** Follow the edit that was just made: show its file and light up what it wrote. */
  private show(op: ReturnType<Replayer['advanceTo']>): void {
    if (!op) return;
    this.rev.update((n) => n + 1);
    this.focusFile.set(op[2]);
    this.lastEdit.set(op[1] === 'e' ? { pos: op[3], len: op[5].length } : { pos: 0, len: 0 });
  }

  protected toggle(): void {
    if (this.playing()) this.stop();
    else this.play();
  }

  protected scrub(value: number | string): void {
    const r = this.replayer();
    if (!r) return;
    const v = Number(value);
    this.vt.set(v);
    this.show(r.seekTo(v));
    this.rev.update((n) => n + 1);
  }

  protected setSpeed(v: string): void {
    this.speed.set(v);
  }

  protected pick(file: string): void {
    this.pinned.set(file === this.pinned() ? null : file);
  }

  @HostListener('document:keydown', ['$event'])
  protected key(e: KeyboardEvent): void {
    if (!this.dlg().nativeElement.open) return;
    if (e.key === ' ' && !(e.target as HTMLElement).closest('button, select, input')) {
      e.preventDefault();
      this.toggle();
    }
  }
}
