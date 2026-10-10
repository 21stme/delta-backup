import test from 'node:test';
import assert from 'node:assert/strict';
import { goToOriginalTab } from '../extension/navigation.js';
const entry = { tabId: 7, url: 'https://delta.yandex-team.ru/doc?id=1#text' };
test('explicit source navigation activates the existing tab and its window without creating a tab', async () => {
  const calls = [];
  const tabs = { get: async id => ({ id, windowId: 2, url: entry.url }), update: async (...args) => calls.push(['tab', ...args]), create: () => assert.fail('No new tab') };
  await goToOriginalTab(entry, tabs, { update: async (...args) => calls.push(['window', ...args]) });
  assert.deepEqual(calls, [['tab', 7, { active: true }], ['window', 2, { focused: true }]]);
});
test('closed, navigated or reused source IDs cannot activate a different document', async () => {
  for (const get of [async () => { throw new Error('closed'); }, async () => ({ id: 7, windowId: 2, url: entry.url.replace('id=1','id=2') })]) {
    await assert.rejects(goToOriginalTab(entry, { get, update: () => assert.fail('No activation') }, {}));
  }
});
test('history rows have no source navigation and invoke no tabs API', async () => {
  await assert.rejects(goToOriginalTab({ ...entry, source: 'history' }, { get: () => assert.fail('History has no existing tab') }, {}));
});
