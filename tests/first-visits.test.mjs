import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { collectFirstVisits } from '../extension/browser-history.js';
import { archiveFiles } from '../extension/archive.js';

const origin = 'https://delta.yandex-team.ru';
const first = Date.parse('2026-01-02T12:00:00Z');
const last = Date.parse('2026-10-09T12:00:00Z');
const entry = (suffix, extra = {}) => ({ url: `${origin}/synthetic/${suffix}`, status: 'captured', captureId: suffix, ...extra });
const cleanFiles = files => files.filter(file => file.name.startsWith('Чистые/'));
const day = time => new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time));

test('first visit uses the earliest valid saved event, querying exact Delta URLs only', async () => {
  const entries = [entry('a?mode=one#one'), entry('a?mode=one#two'), entry('a?mode=two#one'), { url: 'https://example.org/' }];
  const before = structuredClone(entries), calls = [];
  const result = await collectFirstVisits(entries, async props => {
    calls.push(props);
    return [{ visitTime: last }, { visitTime: first }, { visitTime: first + 1 }, { visitTime: -1 }, { visitTime: '1' }, { visitTime: Infinity }, { visitTime: Date.now() + 86400000 }];
  });
  assert.deepEqual(calls.map(call => call.url).sort(), entries.slice(0, 3).map(item => item.url).sort());
  assert.ok(result.entries.slice(0, 3).every(item => item.firstVisitTime === first));
  assert.equal(result.entries[3].firstVisitLookup.status, 'invalid_url');
  assert.equal(result.coverage, 'partial');
  assert.deepEqual(entries, before);
});

test('duplicate tabs share one history lookup, bounded concurrency and separate archive entries', async () => {
  const entries = [entry('a'), entry('a'), entry('b'), entry('c')];
  let active = 0, peak = 0, calls = 0;
  const result = await collectFirstVisits(entries, async () => {
    active++; peak = Math.max(peak, active); calls++;
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    return [{ visitTime: first }];
  }, { concurrency: 2 });
  assert.equal(calls, 3); assert.equal(peak, 2); assert.equal(result.entries.length, 4);
  const files = await archiveFiles({ source: 'open_tabs', settings: { firstVisitDate: true }, entries: result.entries }, async () => ({ text: '== Заметка\nТело', samples: [] }));
  assert.equal(cleanFiles(files).length, 4);
  assert.equal(new Set(cleanFiles(files).map(file => file.name)).size, 4);
});

test('missing history, invalid timestamps, denied permission and API failure remain distinct', async () => {
  for (const [api, status, coverage] of [
    [async () => [], 'not_found', 'complete'],
    [async () => [{ visitTime: 0 }, { visitTime: null }], 'invalid_response', 'partial'],
    [async () => null, 'invalid_response', 'partial'],
    [async () => { throw new Error('access revoked'); }, 'api_error', 'partial']
  ]) {
    const result = await collectFirstVisits([entry('a')], api);
    assert.equal(result.entries[0].firstVisitLookup.status, status);
    assert.equal(result.entries[0].firstVisitTime, undefined); assert.equal(result.coverage, coverage);
    assert.equal(result.entries[0].captureId, 'a'); assert.equal(result.entries[0].status, 'captured');
  }
  const denied = await collectFirstVisits([entry('a')], undefined, { unavailableReason: 'permission_denied' });
  assert.equal(denied.entries[0].firstVisitLookup.status, 'permission_denied'); assert.equal(denied.calls, 0);
});

test('an unresponsive history API is bounded without losing the saved text', async () => {
  const result = await collectFirstVisits([entry('a')], () => new Promise(() => {}), { callTimeoutMs: 5 });
  assert.equal(result.entries[0].firstVisitLookup.status, 'timeout');
  const files = await archiveFiles({ source: 'open_tabs', settings: { firstVisitDate: true }, entries: result.entries }, async () => ({ text: 'Заметка\nПолный текст', samples: [] }));
  assert.deepEqual(cleanFiles(files), [{ name: 'Чистые/Дата неизвестна - Заметка.md', data: 'Заметка\nПолный текст' }]);
});

test('the total deadline also bounds unstarted URL lookups', async () => {
  const result = await collectFirstVisits([entry('a'), entry('b'), entry('c')], () => new Promise(() => {}), { concurrency: 1, callTimeoutMs: 1000, maxDurationMs: 5 });
  assert.equal(result.calls, 1);
  assert.ok(result.entries.every(item => item.firstVisitLookup.status === 'time_limit'));
});

test('pause and resume preserve known dates and look up only the remaining URLs', async () => {
  let paused = false;
  const initial = await collectFirstVisits([entry('a'), entry('b')], async () => [{ visitTime: first }], {
    concurrency: 1, cancelled: () => paused, onProgress: async () => { paused = true; }
  });
  assert.equal(initial.entries[1].firstVisitLookup.status, 'cancelled');
  const saved = structuredClone(initial.entries[0].firstVisitLookup), calls = [];
  const resumed = await collectFirstVisits(initial.entries, async ({ url }) => { calls.push(url); return []; });
  assert.deepEqual(calls, [entry('b').url]);
  assert.equal(resumed.entries[0].firstVisitTime, first);
  assert.deepEqual(resumed.entries[0].firstVisitLookup, saved);
  assert.equal(resumed.entries[1].firstVisitLookup.status, 'not_found');
  assert.equal(resumed.coverage, 'complete');
  const cached = await collectFirstVisits(resumed.entries, () => assert.fail('must not query history again'));
  assert.equal(cached.calls, 0);
});

test('optional first-visit prefixes preserve raw text, history last-visit dates and old undated backups', async () => {
  const entries = [entry('a', { firstVisitTime: first, lastVisitTime: last }), entry('b'), entry('c', { source: 'history', firstVisitTime: first, lastVisitTime: last })];
  const source = '== Заметка\r\nТело **без изменений**\r\n';
  const run = { source: 'open_tabs', createdAt: '2030-01-01', settings: { firstVisitDate: true }, entries };
  const files = await archiveFiles(run, async () => ({ text: source, samples: [] }));
  assert.deepEqual(cleanFiles(files).map(file => file.name), [`Чистые/${day(first)} - == Заметка.md`, 'Чистые/Дата неизвестна - == Заметка.md', `Чистые/${day(last)} - == Заметка.md`]);
  assert.ok(cleanFiles(files).every(file => file.data === source));
  const report = JSON.parse(files.find(file => file.name === 'report.json').data);
  assert.equal(report.entries[0].firstVisitTime, first);
  assert.ok(report.entries.every(item => item.cleanTitle === '== Заметка'));
  const off = await archiveFiles({ ...run, settings: { firstVisitDate: false } }, async () => ({ text: source, samples: [] }));
  assert.deepEqual(cleanFiles(off).map(file => file.name), ['Чистые/== Заметка.md', 'Чистые/== Заметка (2).md', `Чистые/${day(last)} - == Заметка.md`]);
  const legacy = await archiveFiles({ source: 'open_tabs', entries: [entries[0]] }, async () => ({ text: source, samples: [] }));
  assert.equal(cleanFiles(legacy)[0].name, 'Чистые/== Заметка.md');
});

test('first-visit filenames use the browser-local day across midnight', () => {
  const moduleUrl = new URL('../extension/archive.js', import.meta.url).href;
  const source = `import {archiveFiles} from ${JSON.stringify(moduleUrl)};
    const files=await archiveFiles({source:'open_tabs',settings:{firstVisitDate:true},entries:[{captureId:'c',status:'captured',firstVisitTime:Date.parse('2026-10-09T21:30:00Z')}]},async()=>({text:'Ночь',samples:[]}));
    console.log(JSON.stringify(files.filter(file=>file.name.startsWith('Чистые/'))));`;
  for (const [zone, date] of [['Europe/Moscow', '2026-10-10'], ['America/New_York', '2026-10-09']]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, TZ: zone }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [{ name: `Чистые/${date} - Ночь.md`, data: 'Ночь' }]);
  }
});
