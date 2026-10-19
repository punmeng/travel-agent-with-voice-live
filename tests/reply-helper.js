import { chat } from '../lib/agents.js';
import { countWords } from '../lib/replies.js';
import assert from 'node:assert/strict';
export async function readAll(session, response, env = { APP_MODE: 'mock' }) {
  const texts = [response.text];
  assert.ok(countWords(response.text) <= 50);
  let next = response, pages = 0;
  while (next.state.moreReply) {
    assert.ok(++pages < 100, 'bounded reply pages');
    next = await chat(session, { message: '繼續' }, env);
    assert.ok(countWords(next.text) <= 50);
    texts.push(next.text);
  }
  return { ...response, text: texts.join('\n'), state: next.state };
}
