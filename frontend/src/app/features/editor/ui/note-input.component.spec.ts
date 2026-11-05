import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { NoteInputComponent } from './note-input.component';

function setup(over: { names?: string[]; disabled?: boolean; cancellable?: boolean } = {}) {
  const fixture = TestBed.createComponent(NoteInputComponent);
  fixture.componentRef.setInput('names', over.names ?? ['Aelith', 'Marcus Reed', 'Gabriel']);
  fixture.componentRef.setInput('disabled', over.disabled ?? false);
  fixture.componentRef.setInput('cancellable', over.cancellable ?? false);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  const ta = host.querySelector('textarea') as HTMLTextAreaElement;
  const sent: string[] = [];
  const cancelled: number[] = [];
  fixture.componentInstance.submit.subscribe((t) => sent.push(t));
  fixture.componentInstance.cancel.subscribe(() => cancelled.push(1));
  const type = (value: string, caret = value.length) => {
    ta.value = value;
    ta.setSelectionRange(caret, caret);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
  };
  const key = (k: string, extra: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra });
    ta.dispatchEvent(e);
    fixture.detectChanges();
    return e;
  };
  const picks = () => Array.from(host.querySelectorAll('.pick button')).map((b) => b.textContent!.trim());
  return { fixture, host, ta, sent, cancelled, type, key, picks };
}

describe('NoteInputComponent', () => {
  it('sends on Enter, keeps Shift+Enter for a new line, and ignores an empty note', () => {
    const { type, key, sent } = setup();
    key('Enter');
    expect(sent).toEqual([]);
    type('  hello there  ');
    expect(key('Enter', { shiftKey: true }).defaultPrevented).toBe(false);
    expect(sent).toEqual([]);
    expect(key('Enter').defaultPrevented).toBe(true);
    expect(sent).toEqual(['hello there']);
  });

  it('suggests scribes after an @ and narrows as you type', () => {
    const { type, picks } = setup();
    type('see @');
    expect(picks()).toEqual(['@Aelith', '@Marcus Reed', '@Gabriel']);
    type('see @ma');
    expect(picks()).toEqual(['@Marcus Reed']);
    type('see @zzz');
    expect(picks()).toEqual([]);
    type('mail me@ma');
    expect(picks()).toEqual([]);
  });

  it('picks a suggestion with the keyboard instead of sending', () => {
    const { type, key, picks, ta, sent, fixture } = setup();
    type('hi @');
    key('ArrowDown');
    expect(fixture.nativeElement.querySelector('.pick button.on')!.textContent.trim()).toBe('@Marcus Reed');
    key('Enter');
    expect(sent).toEqual([]);
    expect(ta.value).toBe('hi @Marcus Reed ');
    expect(picks()).toEqual([]);
  });

  it('picks with a click, and Escape closes the list without clearing the text', () => {
    const { type, key, picks, ta, host, fixture } = setup();
    type('a @gab');
    (host.querySelector('.pick button') as HTMLElement).click();
    fixture.detectChanges();
    expect(ta.value).toBe('a @Gabriel ');
    type('b @');
    key('Escape');
    expect(picks()).toEqual([]);
    expect(ta.value).toBe('b @');
  });

  it('the "Mention a scribe" button types an @ and opens the list', () => {
    const { host, fixture, ta, picks, type } = setup();
    type('hello');
    (host.querySelector('.at') as HTMLElement).click();
    fixture.detectChanges();
    expect(ta.value).toBe('hello @');
    return Promise.resolve().then(() => {
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      fixture.detectChanges();
      expect(picks().length).toBeGreaterThan(0);
    });
  });

  it('can be cancelled with Escape or the button, only when cancellable', () => {
    const a = setup({ cancellable: true });
    a.key('Escape');
    (a.host.querySelector('.btn--ink') as HTMLElement).click();
    expect(a.cancelled).toHaveLength(2);
    const b = setup();
    b.key('Escape');
    expect(b.cancelled).toEqual([]);
    expect(b.host.querySelector('.btn--ink')).toBeNull();
  });

  it('cannot be used when disabled', () => {
    const { ta, host, key, sent, type } = setup({ disabled: true });
    expect(ta.disabled).toBe(true);
    type('hello');
    key('Enter');
    expect(sent).toEqual([]);
    expect((host.querySelector('.btn:not(.btn--ink)') as HTMLButtonElement).disabled).toBe(true);
  });

  it('can be emptied from outside', () => {
    const { fixture, type, ta } = setup();
    type('draft');
    fixture.componentInstance.clear();
    fixture.detectChanges();
    expect(ta.value).toBe('');
  });
});
