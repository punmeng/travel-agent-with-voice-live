import assert from 'node:assert/strict';
export async function readAll(_session, response) {
  assert.equal(response.state.moreReply, false, 'canonical answer is complete without user paging');
  return response;
}
