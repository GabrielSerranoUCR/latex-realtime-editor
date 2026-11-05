import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiError, buildMatcher, describeCompile, describeQueued, numberLines, searchTexts } from '../src/lib.mjs';

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
