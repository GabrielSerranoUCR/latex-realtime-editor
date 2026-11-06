import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeBase64, humanBytes, pictureType, titleMatches, apiError, buildMatcher, describeCompile, describeQueued, numberLines, searchTexts } from '../src/lib.mjs';

test('numberLines numbers like an editor and pads to the widest number', () => {
  assert.equal(numberLines('a\nb\n'), '1 | a\n2 | b');
  assert.equal(numberLines('x', 9), '9 | x');
  assert.equal(numberLines('a\nb', 9), ' 9 | a\n10 | b');
  assert.equal(numberLines(''), '');
});

test('buildMatcher: literal, whole word, case and bad patterns', () => {
  assert.deepEqual('a.b axb'.match(buildMatcher('a.b').re), ['a.b']);
  assert.equal('Cat cat'.match(buildMatcher('cat').re).length, 2);
  assert.equal('Cat cat'.match(buildMatcher('cat', { caseSensitive: true }).re).length, 1);
  assert.equal('cat concat'.match(buildMatcher('cat', { wholeWord: true }).re).length, 1);
  assert.ok(buildMatcher('(', { regex: true }).error);
  assert.ok(buildMatcher('').error);
});

test('searchTexts reports file, line and column and caps the list', () => {
  const files = [
    { path: 'a.tex', text: 'one\ntwo Hamiltonian\nthree' },
    { path: 'b.tex', text: 'Hamiltonian Hamiltonian' },
  ];
  const r = searchTexts(files, 'hamiltonian');
  assert.equal(r.total, 3);
  assert.deepEqual(r.hits[0], { path: 'a.tex', line: 2, column: 5, text: 'two Hamiltonian' });
  assert.equal(r.hits[2].column, 13);
  const capped = searchTexts(files, 'hamiltonian', {}, 2);
  assert.equal(capped.hits.length, 2);
  assert.equal(capped.truncated, true);
  assert.equal(searchTexts(files, '(', { regex: true }).error, 'That is not a valid regular expression.');
  assert.equal(searchTexts(files, 'zzz').total, 0);
});

test('apiError speaks to the model', () => {
  assert.match(apiError(401), /Access tokens/);
  assert.match(apiError(403, { error: 'x' }), /read-only/);
  assert.match(apiError(404, null), /list_scrolls/);
  assert.equal(apiError(409, { error: '`oldText` was not found' }), '`oldText` was not found');
  assert.match(apiError(0, { error: 'ECONNREFUSED' }), /QUILL_URL/);
  assert.equal(apiError(500, { error: 'boom' }), 'boom');
});

test('describeCompile lists errors with their place, and the log tail on failure only', () => {
  const failed = describeCompile({ ok: false, durationMs: 900, log: 'a\nb\nc', diagnostics: [{ severity: 'error', file: 'main.tex', line: 3, message: 'Undefined control sequence' }, { severity: 'warning', file: null, line: null, message: 'Underfull' }] });
  assert.match(failed, /FAILED/);
  assert.match(failed, /main\.tex:3: Undefined control sequence/);
  assert.match(failed, /unknown location: Underfull/);
  assert.match(failed, /End of the log/);
  const good = describeCompile({ ok: true, durationMs: 10, log: 'noise', diagnostics: [] });
  assert.match(good, /Compiled successfully/);
  assert.doesNotMatch(good, /End of the log/);
});

test('describeQueued says plainly that nothing changed yet', () => {
  assert.match(describeQueued({ proposalId: 'abc' }), /QUEUED, NOT APPLIED.*abc/);
});

test('pictureType knows the endings the server accepts', () => {
  assert.equal(pictureType('figures/A.PNG'), 'image/png');
  assert.equal(pictureType('x.jpeg'), 'image/jpeg');
  assert.equal(pictureType('doc.pdf'), 'application/pdf');
  assert.equal(pictureType('run.exe'), null);
  assert.equal(pictureType('noending'), null);
});

test('decodeBase64 takes base64 or a data URL and refuses the rest', () => {
  assert.equal(decodeBase64('aGVsbG8=').toString(), 'hello');
  assert.equal(decodeBase64('data:image/png;base64,aGVs\nbG8=').toString(), 'hello');
  assert.equal(decodeBase64('not base64!'), null);
  assert.equal(decodeBase64(''), null);
});

test('titleMatches compares like a person and never matches nothing', () => {
  assert.equal(titleMatches('Etapa II Wayfinders Copy', ' etapa ii wayfinders copy '), true);
  assert.equal(titleMatches('A', 'B'), false);
  assert.equal(titleMatches('', ''), false);
  assert.equal(titleMatches('A', undefined), false);
});

test('humanBytes is short and readable', () => {
  assert.equal(humanBytes(500), '500 bytes');
  assert.equal(humanBytes(2048), '2.0 KB');
  assert.equal(humanBytes(5 * 1024 * 1024), '5.0 MB');
});

test('describeNotes shows place, state and every message', async () => {
  const { describeNotes } = await import('../src/lib.mjs');
  assert.equal(describeNotes([]), 'No notes.');
  const out = describeNotes([
    { id: 'a', file: 'main.tex', line: 4, quote: 'x', resolved: false, resolvedBy: null, messages: [{ author: 'Ann', text: 'why?' }, { author: 'Bo', text: 'fixed' }] },
    { id: 'b', file: 'm.tex', line: null, quote: '', resolved: true, resolvedBy: 'Ann', messages: [{ author: 'Ann', text: 'ok' }] },
  ]);
  assert.match(out, /a  main\.tex:4  open  on “x”\n {4}Ann: why\?\n {4}Bo: fixed/);
  assert.match(out, /b  m\.tex \(the text it was about is gone\)  RESOLVED by Ann/);
});
