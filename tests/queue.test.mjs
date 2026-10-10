import test from 'node:test';
import assert from 'node:assert/strict';
import { runBatch, createRunWriter } from '../extension/queue.js';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('pool fills X slots, refills a freed slot and visits every page once', async () => {
  const gates = Array.from({ length: 5 }, deferred);
  let active = 0, peak = 0; const started = [], completed = [];
  const task = runBatch([0, 1, 2, 3, 4], 2, async id => {
    started.push(id); active++; peak = Math.max(peak, active);
    await gates[id].promise; active--; completed.push(id);
  });
  assert.deepEqual(started, [0, 1]);
  gates[1].resolve(); await tick(); assert.deepEqual(started, [0, 1, 2]);
  gates[0].resolve(); await tick(); assert.deepEqual(started, [0, 1, 2, 3]);
  gates[2].resolve(); await tick(); assert.deepEqual(started, [0, 1, 2, 3, 4]);
  gates[3].resolve(); gates[4].resolve(); await task;
  assert.equal(peak, 2); assert.deepEqual(completed.sort(), [0, 1, 2, 3, 4]);
});
test('pause stops issuing pages and waits for active pages to settle', async () => {
  const gate = deferred(); const started = []; let paused = false, settled = false;
  const task = runBatch([0, 1, 2], 2, async id => { started.push(id); await gate.promise; }, { paused: () => paused }).then(() => { settled = true; });
  paused = true; await tick(); assert.equal(settled, false);
  gate.resolve(); await task; assert.deepEqual(started, [0, 1]);
});
test('storage failure stops issuing jobs and cancels active capture before throwing', async () => {
  const gate = deferred(); const failure = new Error('QuotaExceededError'); const started = [];
  let activeSettled = false;
  const task = runBatch([0, 1, 2], 2, async (id, stopped) => {
    started.push(id);
    if (id === 0) { await tick(); throw failure; }
    await gate.promise; assert.equal(stopped(), true); activeSettled = true;
  });
  await tick(); gate.resolve(); await assert.rejects(task, error => error === failure);
  assert.equal(activeSettled, true); assert.deepEqual(started, [0, 1]);
});
test('concurrency settings reject out of bounds and support a single page', async () => {
  for (const value of [0, 11, 1.5, NaN]) await assert.rejects(runBatch([], value, () => {}));
  const started = []; await runBatch([1, 2], 1, async id => started.push(id)); assert.deepEqual(started, [1, 2]);
});
test('parallel saves never persist a capture reference before its text', async () => {
  const firstWrite = deferred(); const stored = new Set(), snapshots = [];
  const run = { entries: [{}, {}] };
  const write = createRunWriter(async (value, capture) => {
    if (!snapshots.length) await firstWrite.promise;
    stored.add(capture.id);
    const copy = structuredClone(value); snapshots.push(copy);
    assert.ok(copy.entries.every(entry => !entry.captureId || stored.has(entry.captureId)));
  }, () => run);
  const a = write({ id: 'a', text: 'A' }, () => { run.entries[0].captureId = 'a'; });
  const b = write({ id: 'b', text: 'B' }, () => { run.entries[1].captureId = 'b'; });
  await tick(); assert.ok(!run.entries[1].captureId);
  firstWrite.resolve(); await Promise.all([a, b]);
  assert.deepEqual(snapshots.map(value => value.entries.map(entry => entry.captureId)), [['a', undefined], ['a', 'b']]);
});
test('failed save rejects queued writes without mutating later success state', async () => {
  const run = { entries: [{}, {}] }; const failure = new Error('disk');
  const write = createRunWriter(async () => { throw failure; }, () => run);
  const a = write({ id: 'a' }, () => { run.entries[0].captureId = 'a'; });
  const b = write({ id: 'b' }, () => { run.entries[1].captureId = 'b'; });
  const outcomes = await Promise.allSettled([a, b]);
  assert.ok(outcomes.every(value => value.status === 'rejected' && value.reason === failure));
  assert.ok(!run.entries[1].captureId);
});
