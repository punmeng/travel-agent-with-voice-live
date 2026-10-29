import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z, ZodError } from 'zod';
import { schemaIssues, parseJourneyInput } from '../lib/validation.js';

test('schema diagnostics include only bounded codes and allowlisted paths, never messages or values', () => {
  const error = new ZodError(Array.from({ length: 12 }, () => ({
    code: 'custom', path: ['meetings', 0, 'sensitive-user-key', ...Array(10).fill('location')],
    message: 'private input should never be logged', params: { text: 'private value' }
  })));
  const issues = schemaIssues(error);
  assert.equal(issues.length, 8);
  assert.equal(issues[0].path.length, 8);
  assert.deepEqual(issues[0].path.slice(0, 3), ['meetings', 0, 'other']);
  assert.ok(!JSON.stringify(issues).includes('private'));
  assert.ok(!JSON.stringify(issues).includes('sensitive'));
  assert.equal(schemaIssues(new Error('not schema')), undefined);
});
test('expected journey validation is recoverable but unexpected exceptions propagate unchanged', () => {
  assert.throws(() => parseJourneyInput(z.number(), 'bad', 'TRIP_INPUT', 'journey.trip', '需求不符'), error => {
    assert.equal(error.code, 'TRIP_INPUT'); assert.equal(error.stage, 'journey.trip');
    assert.deepEqual(schemaIssues(error), [{ code: 'invalid_type', path: [] }]); return true;
  });
  const unexpected = new Error('unexpected');
  assert.throws(() => parseJourneyInput({ parse() { throw unexpected; } }, null), error => error === unexpected);
});
