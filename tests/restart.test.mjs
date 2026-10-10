import test from 'node:test';
import assert from 'node:assert/strict';
import { restartBackup } from '../extension/restart.js';
import { VERSION } from '../extension/core.js';
const settings = { timeout: 180, stable: 12, concurrency: 3 };

test('restart of open tabs inventories current tabs and preserves the previous backup', async () => {
  const previous = { id: 'old', entries: [{ tabId: 10, status: 'timeout', reason: 'deadline', attempts: 3, captureId: 'old-capture' }] };
  const before = structuredClone(previous);
  const fresh = await restartBackup(previous, settings, async options => {
    assert.deepEqual(options, settings);
    return { id: 'new', entries: [{ tabId: 20, status: 'pending', attempts: 0 }], settings: options };
  });
  assert.deepEqual(previous, before); assert.notEqual(fresh.id, previous.id);
  assert.equal(fresh.restartedFrom, previous.id); assert.equal(fresh.entries[0].tabId, 20);
  assert.ok(!fresh.entries[0].captureId); assert.equal(fresh.entries[0].attempts, 0);
});
test('restart of history keeps selected URLs but never reuses captures, attempts or owned tabs', async () => {
  const previous = { id: 'old-history', source: 'history', historySearch: { found: 5, selected: 1, coverage: 'partial' }, entries: [{ id: 'old-entry', historyId: 'h1', url: 'https://delta.yandex-team.ru/page?id=1#text', title: 'A', lastVisitTime: 17, visitCount: 2, status: 'captured', attempts: 2, captureId: 'old-capture', characters: 630, reviewed: true, temporaryTabs: [{ tabId: 11 }] }] };
  const before = structuredClone(previous);
  const fresh = await restartBackup(previous, settings, () => assert.fail('History does not inventory open tabs'));
  assert.deepEqual(previous, before); assert.equal(fresh.version, VERSION);
  assert.notEqual(fresh.id, previous.id); assert.notEqual(fresh.entries[0].id, previous.entries[0].id);
  assert.equal(fresh.entries[0].url, previous.entries[0].url); assert.equal(fresh.entries[0].historyId, 'h1');
  assert.equal(fresh.entries[0].status, 'pending'); assert.equal(fresh.entries[0].attempts, 0);
  assert.deepEqual(fresh.entries[0].temporaryTabs, []); assert.equal(fresh.entries[0].reviewed, false);
  assert.ok(!fresh.entries[0].captureId); assert.ok(!fresh.entries[0].characters);
  assert.equal(fresh.historySearch.coverage, 'partial');
});
