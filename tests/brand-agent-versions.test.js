import test from 'node:test';
import assert from 'node:assert/strict';
import { niBrandPromptCandidate } from '../scripts/create-ni-brand-agent-versions.js';

test('Ni brand candidate changes only prompt text and preserves every other definition field', () => {
  const source = {
    name: 'ci-intent-agent',
    version: '8',
    definition: {
      kind: 'prompt',
      model: 'gpt-5.4',
      instructions: '你是「梅好旅程」旅程協作團隊；你是梅好 Airlines示範旅行助理。',
      tools: [{ type: 'function', name: 'list_airports', parameters: { additionalProperties: false } }],
      temperature: 0.2
    }
  };
  const candidate = niBrandPromptCandidate(source, 'intent');
  assert.deepEqual(candidate.changedPaths, ['definition.instructions']);
  assert.deepEqual(candidate.replacements.map(item => item.count), [1, 1]);
  assert.equal(candidate.definition.instructions, '你是「Ni Airlines」旅程協作團隊；你是Ni Airlines示範旅行助理。');
  const originalDefinition = structuredClone(source.definition);
  originalDefinition.instructions = candidate.definition.instructions;
  assert.deepEqual(candidate.definition, originalDefinition);
  assert.equal(source.definition.instructions.includes('梅好'), true);
});

test('Ni brand candidate refuses clean prompts and unexpected legacy brand references', () => {
  const source = { definition: { kind: 'prompt', model: 'gpt-5.4', instructions: 'Already current.' } };
  assert.throws(() => niBrandPromptCandidate(source, 'intent'), /absent or unexpected/);
  source.definition.instructions = '梅好 Airlines; 梅好旅程; Meihao demo';
  assert.throws(() => niBrandPromptCandidate(source, 'intent'), /unexpected brand references remain/);
});

test('Ni brand candidate refuses an unapproved prompt model or agent kind', () => {
  for (const definition of [
    { kind: 'voice', model: 'gpt-5.4', instructions: '梅好 Airlines' },
    { kind: 'prompt', model: 'other-model', instructions: '梅好 Airlines' }
  ]) {
    assert.throws(() => niBrandPromptCandidate({ definition }, 'intent'), /source definition does not match/);
  }
});
