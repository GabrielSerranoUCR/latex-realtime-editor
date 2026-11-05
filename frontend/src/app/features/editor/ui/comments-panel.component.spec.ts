import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { Located, NoteThread } from '../../../core/collab/comments';
import { CommentsPanelComponent } from './comments-panel.component';

const msg = (id: string, author: string, text: string, authorId = author.toLowerCase(), at = Date.now() - 3600_000) => ({ id, authorId, authorName: author, authorColor: '#C9A04A', text, at });
const thread = (id: string, over: Partial<NoteThread> = {}): NoteThread => ({ id, file: 'main.tex', anchor: { start: 0, end: 0 }, quote: 'We study the ground state', resolved: false, resolvedBy: null, createdAt: 1, messages: [msg(`${id}-1`, 'Aelith', 'Should we say “quantum harmonic oscillator”?')], ...over });
const located = (t: NoteThread, line: number | null = 13, lost = false): Located<NoteThread> => ({ thread: t, line, lost, from: 10, to: 20 });

function setup(threads: Array<Located<NoteThread>>, over: { canWrite?: boolean; canManage?: boolean; meId?: string; selectedId?: string; activeFile?: string } = {}) {
  const fixture = TestBed.createComponent(CommentsPanelComponent);
  fixture.componentRef.setInput('threads', threads);
  fixture.componentRef.setInput('activeFile', over.activeFile ?? 'main.tex');
  fixture.componentRef.setInput('canWrite', over.canWrite ?? true);
  fixture.componentRef.setInput('canManage', over.canManage ?? false);
  fixture.componentRef.setInput('meId', over.meId ?? 'aelith');
  fixture.componentRef.setInput('meName', 'Aelith');
  fixture.componentRef.setInput('names', ['Aelith', 'Gabriel']);
  fixture.componentRef.setInput('cursorLine', 17);
  if (over.selectedId) fixture.componentRef.setInput('selectedId', over.selectedId);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  const c = fixture.componentInstance;
  const events: string[] = [];
  c.select.subscribe((id) => events.push(`select:${id}`));
  c.post.subscribe((t) => events.push(`post:${t}`));
  c.reply.subscribe((e) => events.push(`reply:${e.id}:${e.text}`));
  c.resolve.subscribe((e) => events.push(`resolve:${e.id}:${e.resolved}`));
  c.removeMessage.subscribe((e) => events.push(`rm:${e.id}:${e.messageId}`));
  c.removeThread.subscribe((id) => events.push(`rmthread:${id}`));
  const click = (el: Element | null) => {
    (el as HTMLElement).click();
    fixture.detectChanges();
  };
  return { fixture, host, events, click };
}

describe('CommentsPanelComponent', () => {
  it('shows the open count and a card per open thread, with its line and quote', () => {
    const { host } = setup([located(thread('a')), located(thread('b', { resolved: true, resolvedBy: 'Gabriel' }), 17)]);
    expect(host.querySelector('.open-chip')!.textContent).toContain('1 open');
    const cards = host.querySelectorAll('.thread');
    expect(cards).toHaveLength(1);
    expect(cards[0].querySelector('.ln')!.textContent).toBe('line 13');
    expect(cards[0].querySelector('.quote')!.textContent).toContain('We study the ground state');
    expect(cards[0].textContent).toContain('Should we say');
  });

  it('filters between open, resolved and all', () => {
    const { host, click } = setup([located(thread('a')), located(thread('b', { resolved: true, resolvedBy: 'Gabriel' }), 17)]);
    const chip = (label: string) => Array.from(host.querySelectorAll('.chip-f')).find((b) => b.textContent!.trim() === label)!;
    click(chip('Resolved'));
    expect(host.querySelectorAll('.thread')).toHaveLength(1);
    expect(host.querySelector('.thread .done')!.textContent).toContain('Resolved by Gabriel');
    click(chip('All'));
    expect(host.querySelectorAll('.thread')).toHaveLength(2);
  });

  it('says what to do when there are no notes at all, or none in this filter', () => {
    expect(setup([]).host.querySelector('.none')!.textContent).toContain('No margin notes yet');
    const only = setup([located(thread('b', { resolved: true }))]);
    expect(only.host.querySelector('.none')!.textContent).toContain('No open notes');
  });

  it('names the file when the note is in another file, and says when text or file is gone', () => {
    const { host } = setup([located(thread('a', { file: 'intro.tex' })), located(thread('b'), 5, true), located(thread('c'), null, true)]);
    const wheres = Array.from(host.querySelectorAll('.where')).map((w) => w.textContent!.replace(/\s+/g, ' ').trim());
    expect(wheres[0]).toContain('intro.tex');
    expect(wheres[1]).toContain('the text was removed');
    expect(wheres[2]).toContain('file removed');
  });

  it('highlights the picked thread and emits a select when its header is clicked', () => {
    const { host, events, click } = setup([located(thread('a')), located(thread('b'), 17)], { selectedId: 'b' });
    expect(host.querySelector('[data-thread="b"]')!.classList.contains('on')).toBe(true);
    click(host.querySelector('[data-thread="a"] .where'));
    expect(events).toEqual(['select:a']);
  });

  it('highlights @mentions, and your own more strongly', () => {
    const t = thread('a', { messages: [msg('m', 'Gabriel', 'Thanks @Aelith, and @Gabriel too')] });
    const { host } = setup([located(t)]);
    const mentions = Array.from(host.querySelectorAll('.mention'));
    expect(mentions.map((m) => m.textContent)).toEqual(['@Aelith', '@Gabriel']);
    expect(mentions.map((m) => m.classList.contains('you'))).toEqual([true, false]);
  });

  it('does not turn note text into markup', () => {
    const t = thread('a', { messages: [msg('m', 'Eve', '<img src=x onerror=alert(1)> <b>bold</b>')] });
    const { host } = setup([located(t)]);
    expect(host.querySelector('.thread img')).toBeNull();
    expect(host.querySelector('.thread .text b')).toBeNull();
    expect(host.querySelector('.thread .text')!.textContent).toContain('<img src=x');
  });

  it('replies and resolves or reopens', () => {
    const { host, events, click, fixture } = setup([located(thread('a'))]);
    const acts = () => Array.from(host.querySelectorAll('.act')).map((a) => a.textContent!.trim());
    expect(acts()).toEqual(['Reply', '✓ Resolve', 'Delete thread']);
    click(host.querySelectorAll('.act')[1]);
    click(host.querySelectorAll('.act')[0]);
    const ta = host.querySelector('.thread textarea') as HTMLTextAreaElement;
    ta.value = 'Good call';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    fixture.detectChanges();
    expect(events).toEqual(['resolve:a:true', 'reply:a:Good call']);
    expect(host.querySelector('.thread textarea')).toBeNull();
  });

  it('offers Reopen on a resolved thread', () => {
    const { host, events, click } = setup([located(thread('a', { resolved: true }))]);
    click(Array.from(host.querySelectorAll('.chip-f')).find((b) => b.textContent!.trim() === 'Resolved')!);
    click(host.querySelectorAll('.act')[1]);
    expect(events).toEqual(['resolve:a:false']);
  });

  it('lets you delete only your own notes, and a thread only if you started it or manage the scroll', () => {
    const t = thread('a', { messages: [msg('m1', 'Aelith', 'mine'), msg('m2', 'Gabriel', 'theirs')] });
    const mine = setup([located(t)], { meId: 'aelith' });
    expect(mine.host.querySelectorAll('.del')).toHaveLength(1);
    mine.click(mine.host.querySelector('.del'));
    expect(mine.events).toEqual(['rm:a:m1']);
    expect(mine.host.textContent).toContain('Delete thread');

    const other = setup([located(t)], { meId: 'gabriel' });
    expect(other.host.querySelectorAll('.del')).toHaveLength(1);
    expect(other.host.textContent).not.toContain('Delete thread');
    const manager = setup([located(t)], { meId: 'gabriel', canManage: true });
    manager.click(Array.from(manager.host.querySelectorAll('.act')).find((a) => a.textContent!.includes('Delete thread'))!);
    expect(manager.events).toEqual(['rmthread:a']);
  });

  it('writes a new note about the caret line, and tells readers they cannot', () => {
    const w = setup([]);
    expect(w.host.querySelector('.compose textarea')!.getAttribute('placeholder')).toBe('Write a note about line 17… use @ to mention');
    w.fixture.componentRef.setInput('hasSelection', true);
    w.fixture.detectChanges();
    expect(w.host.querySelector('.compose textarea')!.getAttribute('placeholder')).toContain('about the selection');
    const ta = w.host.querySelector('.compose textarea') as HTMLTextAreaElement;
    ta.value = 'A note';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    w.fixture.detectChanges();
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(w.events).toEqual(['post:A note']);

    const r = setup([located(thread('a'))], { canWrite: false });
    expect(r.host.querySelector('.compose textarea')).toBeNull();
    expect(r.host.querySelector('.ro')!.textContent).toContain('Readers can read');
    expect(r.host.querySelector('.act')).toBeNull();
  });
});
