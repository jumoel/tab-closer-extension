import test from 'node:test';
import assert from 'node:assert/strict';
import { compileRules, escapeRegex, matchingLines, RuleError } from '../rules.js';

test('escaping a pasted URL treats regex syntax as literal text', () => {
  const url = 'https://example.test/a[b]?q=(x+y).*^${z}|\\#done';
  const escaped = String.raw`https://example\.test/a\[b\]\?q=\(x\+y\)\.\*\^\$\{z\}\|\\#done`;
  assert.equal(escapeRegex(url), escaped);
  assert.deepEqual(matchingLines(compileRules(escaped), `prefix${url}suffix`), [1]);
  assert.deepEqual(matchingLines(compileRules(escaped), url.replace('a[b]', 'aXb')), []);
  assert.equal(escapeRegex(String.raw`a\.`), String.raw`a\\\.`);
});

test('blank lines, source spaces, line numbers, anchors, query, and fragment', () => {
  const rules = compileRules('  \n^https://example\\.test/path\\?q=1#done$\n target \n');
  assert.deepEqual(rules.map(rule => rule.line), [2, 3]);
  assert.deepEqual(matchingLines(rules, 'https://example.test/path?q=1#done'), [2]);
  assert.deepEqual(matchingLines(rules, 'prefix target suffix'), [3]);
  assert.deepEqual(matchingLines(rules, 'https://example.test/path?q=1#more'), []);
  assert.deepEqual(matchingLines(compileRules(' \n\t'), 'anything'), []);
});

test('default case sensitivity and browser-supported inline modifier', () => {
  assert.deepEqual(matchingLines(compileRules('reddit'), 'REDDIT'), []);
  const scoped = compileRules('(?i:reddit)');
  assert.deepEqual(matchingLines(scoped, 'REDDIT'), [1]);
});

test('validation and matching failures name the source line', () => {
  assert.throws(() => compileRules('okay\n(\n'), error => error instanceof RuleError && error.line === 2 && error.operation === 'validation');
  const rule = { line: 8, expression: { test() { throw Error('test failure'); } } };
  assert.throws(() => matchingLines([rule], 'x'), error => error instanceof RuleError && error.line === 8 && error.operation === 'matching');
});

test('background stops at first match while tester lists every match', () => {
  const rules = compileRules('example\n^https://example');
  assert.deepEqual(matchingLines(rules, 'https://example.test/', true), [1]);
  assert.deepEqual(matchingLines(rules, 'https://example.test/'), [1, 2]);
});
