import { describe, expect, it } from 'vitest';
import { KEEP_MS, MAX_GAP_MS, MAX_IMPORT_OPS, Op, Replayer, Session, applyOp, autoSpeed, clock, compressTimes, pushOp, validateSession } from './session';

const edit = (t: number, path: string, pos: number, del: number, ins: string): Op => [t, 'e', path, pos, del, ins];

describe('pushOp joins typing and backspacing', () => {
  it('typing on becomes one entry, and counts only the bytes it adds', () => {
    const ops: Op[] = [];
    pushOp(ops, edit(0, 'a.tex', 5, 0, 'h'));
    expect(pushOp(ops, edit(100, 'a.tex', 6, 0, 'i'))).toBe(1);
    pushOp(ops, edit(200, 'a.tex', 7, 0, '!'));
    expect(ops).toEqual([edit(0, 'a.tex', 5, 0, 'hi!')]);
  });
  it('keeps edits apart when they do not continue each other (other file, other place, long pause)', () => {
    const ops: Op[] = [];
    pushOp(ops, edit(0, 'a.tex', 5, 0, 'x'));
    pushOp(ops, edit(50, 'b.tex', 6, 0, 'y'));
    pushOp(ops, edit(60, 'b.tex', 0, 0, 'z'));
    pushOp(ops, edit(5000, 'b.tex', 1, 0, 'w'));
    expect(ops).toHaveLength(4);
  });
  it('a run of backspaces is one deletion', () => {
    const ops: Op[] = [];
    pushOp(ops, edit(0, 'a.tex', 9, 1, ''));
    pushOp(ops, edit(80, 'a.tex', 8, 1, ''));
    pushOp(ops, edit(160, 'a.tex', 7, 1, ''));
    expect(ops).toEqual([edit(0, 'a.tex', 7, 3, '')]);
  });
  it('a replacement is not merged into typing', () => {
    const ops: Op[] = [];
    pushOp(ops, edit(0, 'a.tex', 0, 0, 'ab'));
    pushOp(ops, edit(10, 'a.tex', 2, 1, 'c'));
    expect(ops).toHaveLength(2);
  });
});

describe('applyOp', () => {
  it('edits, creates and deletes files', () => {
    const files = new Map([['a.tex', 'hello world']]);
    applyOp(files, edit(0, 'a.tex', 5, 6, ' there'));
    expect(files.get('a.tex')).toBe('hello there');
    applyOp(files, [1, 'c', 'b.tex', 'new']);
    expect(files.get('b.tex')).toBe('new');
    applyOp(files, [2, 'd', 'a.tex']);
    expect([...files.keys()]).toEqual(['b.tex']);
  });
  it('copes with positions past the end and with files that are not there', () => {
    const files = new Map<string, string>();
    applyOp(files, edit(0, 'x.tex', 99, 5, 'abc'));
    expect(files.get('x.tex')).toBe('abc');
  });
});

describe('validateSession', () => {
  const good: Session = { v: 1, title: 'Thesis', startedAt: 1, durationMs: 100, files: [{ path: 'main.tex', text: 'x' }], ops: [edit(0, 'main.tex', 0, 0, 'y'), [5, 'c', 'b.tex', 't'], [9, 'd', 'b.tex']] };
  it('accepts a good recording unchanged', () => {
    expect(validateSession(JSON.parse(JSON.stringify(good)))).toEqual(good);
  });
  it('turns away anything else, saying what is wrong', () => {
    for (const bad of [null, 'x', [], { v: 2 }, { ...good, files: 'no' }, { ...good, title: 5 }, { ...good, files: [{ path: 1, text: 'x' }] }, { ...good, ops: [[0, 'z', 'a']] }, { ...good, ops: [[5, 'd', 'a'], [1, 'd', 'a']] }, { ...good, ops: [[0, 'e', 'a', -1, 0, 'x']] }]) {
      expect(() => validateSession(bad), JSON.stringify(bad)).toThrow(/session recording/);
    }
  });
  it('refuses a recording with absurdly many edits', () => {
    expect(() => validateSession({ ...good, ops: new Array(MAX_IMPORT_OPS + 1).fill([0, 'd', 'a']) })).toThrow(/too many/);
  });
});

describe('the timelapse clock', () => {
  it('shortens long pauses and adds a short tail', () => {
    const { vt, total } = compressTimes([edit(0, 'a', 0, 0, 'x'), edit(1000, 'a', 1, 0, 'y'), edit(601_000, 'a', 2, 0, 'z')]);
    expect(vt).toEqual([0, 1000, 1000 + MAX_GAP_MS]);
    expect(total).toBe(vt[2] + 600);
  });
  it('picks a speed that fits the whole thing in about a minute, never below real time', () => {
    expect(autoSpeed(20_000)).toBe(1);
    expect(autoSpeed(90_000)).toBe(2);
    expect(autoSpeed(45 * 60_000)).toBe(64);
    expect(autoSpeed(1e12)).toBe(512);
  });
  it('writes clocks', () => {
    expect(clock(0)).toBe('00:00');
    expect(clock(425_000)).toBe('07:05');
    expect(clock(3_729_000)).toBe('1:02:09');
    expect(KEEP_MS).toBe(1_800_000);
  });
});

describe('Replayer', () => {
  const session: Session = {
    v: 1,
    title: 't',
    startedAt: 0,
    durationMs: 10_000,
    files: [{ path: 'a.tex', text: 'start' }],
    ops: Array.from({ length: 4000 }, (_, i) => edit(i * 10, 'a.tex', 5 + i, 0, 'x')),
  };

  it('plays forward and reports the last edit applied', () => {
    const r = new Replayer(session);
    expect(r.texts.get('a.tex')).toBe('start');
    const last = r.advanceTo(100);
    expect(last).toEqual(session.ops[10]);
    expect(r.texts.get('a.tex')).toBe('start' + 'x'.repeat(11));
  });

  it('jumps backwards and forwards to the same text as playing straight through', () => {
    const r = new Replayer(session);
    r.advanceTo(r.total);
    expect(r.texts.get('a.tex')!.length).toBe(5 + 4000);
    r.seekTo(500);
    expect(r.texts.get('a.tex')).toBe('start' + 'x'.repeat(r.appliedCount));
    expect(r.appliedCount).toBe(51);
    r.seekTo(0);
    expect(r.texts.get('a.tex')).toBe('startx');
    r.seekTo(r.total);
    expect(r.texts.get('a.tex')!.length).toBe(4005);
  });

  it('starts from the files as they were, and an empty recording just shows them', () => {
    const r = new Replayer({ ...session, ops: [] });
    expect(r.advanceTo(1e9)).toBeNull();
    expect(r.texts.get('a.tex')).toBe('start');
  });
});
