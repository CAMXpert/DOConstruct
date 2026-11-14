import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLineDiff } from '../src/renderer/change-diff.js';

test('line diff preserves unchanged short context instead of coloring whole chunks', () => {
  const before = 'const first = 1;\n\nconst last = 1;\n';
  const after = 'const first = 2;\n\nconst last = 2;\n';
  const result = buildLineDiff(before, after);
  assert.deepEqual(result.removed.map(range => before.slice(range.from, range.to)), ['const first = 1;\n', 'const last = 1;\n']);
  assert.deepEqual(result.added.map(range => after.slice(range.from, range.to)), ['const first = 2;\n', 'const last = 2;\n']);
});

test('exact line changes reconstruct insertions, deletions, EOF and Unicode snapshots', () => {
  for (const [before, after] of [['', 'const value = "新增";\n'], ['removed\n', ''], ['same\n', 'inserted\nsame\n'], ['a\nb\nc', 'a\nc'], ['last', 'last\n'], ['last\n', 'last'], ['😀\n\nend', '😀\n 新增 \nend'], ['', '']]) {
    const { changes } = buildLineDiff(before, after);
    let actual = before;
    for (const change of changes.toReversed()) actual = actual.slice(0, change.fromA) + after.slice(change.fromB, change.toB) + actual.slice(change.toA);
    assert.equal(actual, after);
  }
});

test('line diff treats indentation changes as changes and uses editor-normalized line endings', () => {
  assert.equal(buildLineDiff('a\r\nb\r\n', 'a\nb\n').changes.length, 0);
  assert.deepEqual(buildLineDiff('  a\n', ' a\n').removed, [{ from: 0, to: 4 }]);
});

test('a bounded diff reports inability to compute rather than returning approximate changes', () => {
  assert.equal(buildLineDiff('before\n', 'after\n', { maxEditLength: 0 }), null);
});
