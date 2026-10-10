import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createZip } from '../extension/zip.js';
import { discoverHistory, historyPeriod, historyEntries, withHistoryTab, historyLinkFiles } from '../extension/browser-history.js';
import { capturePath } from '../extension/core.js';
import { archiveFiles } from '../extension/archive.js';

const origin = 'https://delta.yandex-team.ru';
const period = { kind: 'test', startTime: 0, endTime: 100 };
const link = (id, time, suffix = '') => ({ id: String(id), url: `${origin}/doc/${id}${suffix}`, title: `Документ ${id}`, lastVisitTime: time, visitCount: 3 });
const searchFrom = items => async query => items.filter(item => item.lastVisitTime >= query.startTime && item.lastVisitTime <= query.endTime).sort((a, b) => b.lastVisitTime - a.lastVisitTime).slice(0, query.maxResults);

test('history search explicitly covers requested times and filters the exact origin', async () => {
  const values = [link(1, 50), { ...link(2, 40), url: 'https://delta.yandex-team.ru.evil.test/doc' }, { ...link(3, 30), url: 'https://example.org/?delta.yandex-team.ru' }];
  let query;
  const result = await discoverHistory(async q => { query = q; return values; }, period);
  assert.equal(query.startTime, 0); assert.equal(query.endTime, 100); assert.equal(query.text, 'delta.yandex-team.ru');
  assert.equal(result.links.length, 1); assert.equal(result.coverage, 'complete');
});
test('full history pages are split without losing boundary URLs', async () => {
  const items = [link(1, 1), link(2, 25), link(3, 50), link(4, 75), link(5, 99)];
  const result = await discoverHistory(searchFrom(items), period, { pageSize: 3 });
  assert.equal(result.coverage, 'complete'); assert.equal(result.links.length, 5);
  assert.equal(new Set(result.links.map(item => item.url)).size, 5); assert.ok(result.calls > 1);
});
test('query and hash distinguish documents; exact duplicate URLs are deduplicated', async () => {
  const items = [link(1, 50, '?q=1#one'), link(1, 40, '?q=1#two'), link(1, 30, '?q=2#one'), link(1, 20, '?q=1#one')];
  const result = await discoverHistory(async () => items, period);
  assert.equal(result.links.length, 3); assert.equal(result.links[0].lastVisitTime, 50);
});
test('dense timestamp cannot silently claim complete history', async () => {
  const result = await discoverHistory(searchFrom([link(1, 50), link(2, 50), link(3, 50)]), period, { pageSize: 2 });
  assert.equal(result.coverage, 'partial'); assert.ok(result.limitations.includes('dense_interval')); assert.equal(result.links.length, 2);
});
test('request limit preserves found URLs and explicitly incomplete coverage', async () => {
  const result = await discoverHistory(searchFrom([link(1, 10), link(2, 40), link(3, 70)]), period, { pageSize: 2, maxCalls: 1 });
  assert.equal(result.coverage, 'partial'); assert.ok(result.limitations.includes('request_limit')); assert.ok(result.remainingIntervals > 0); assert.equal(result.links.length, 2);
});
test('failed API does not report empty history as a complete result', async () => {
  const result = await discoverHistory(async () => { throw new Error('denied'); }, period);
  assert.equal(result.coverage, 'partial'); assert.deepEqual(result.limitations, ['api_error']); assert.equal(result.links.length, 0);
});
test('cancelled search makes no API call', async () => {
  let calls = 0;
  const result = await discoverHistory(async () => { calls++; return []; }, period, { cancelled: () => true });
  assert.equal(calls, 0); assert.equal(result.coverage, 'partial'); assert.deepEqual(result.limitations, ['cancelled']);
});
test('API hang is bounded and reported as incomplete', async () => {
  const result = await discoverHistory(() => new Promise(() => {}), period, { callTimeoutMs: 5 });
  assert.equal(result.coverage, 'partial'); assert.ok(result.limitations.includes('api_error'));
});
test('history date ranges include the entire requested final day', () => {
  const now = new Date('2026-10-09T12:00:00').getTime();
  assert.equal(historyPeriod('all', '', '', now).startTime, 0);
  assert.equal(historyPeriod('7', '', '', now).startTime, now - 7 * 86400000);
  const range = historyPeriod('custom', '2026-10-01', '2026-10-02', now);
  assert.equal(range.startTime, new Date('2026-10-01T00:00:00').getTime());
  assert.ok(Math.abs(range.endTime - new Date('2026-10-03T00:00:00').getTime() + 0.001) < 0.001);
  assert.throws(() => historyPeriod('custom', '2026-02-30', '2026-10-02', now));
  assert.throws(() => historyPeriod('custom', '2026-10-02', '2026-10-01', now));
});
test('history entries use stable archive paths independent of transient tab IDs', () => {
  let sequence = 0;
  const entries = historyEntries([link(1, 50), link(1, 50)], () => 'entry-' + ++sequence);
  assert.equal(entries.length, 1); assert.equal(entries[0].tabId, null);
  const before = capturePath(entries[0], 0); entries[0].tabId = 200;
  assert.equal(capturePath(entries[0], 0), before); assert.ok(before.startsWith('История/'));
});
function tabsHarness(changes = {}) {
  const calls = [];
  const tabs = {
    async create(props) { calls.push(['create', props]); return { id: 400, windowId: 4 }; },
    async get(id) { calls.push(['get', id]); return { id, url: `${origin}/doc/1`, active: false, pinned: false, ...changes }; },
    async remove(id) { calls.push(['remove', id]); }
  };
  const entry = historyEntries([link(1, 50)], () => 'entry')[0];
  return { tabs, calls, entry };
}
test('history opens one inactive owned tab, checkpoints it, then closes it', async () => {
  const h = tabsHarness();
  const outcome = await withHistoryTab(h.entry, h.tabs, async () => {
    assert.equal(h.entry.tabId, 400); return { status: 'captured' };
  }, async () => h.calls.push(['checkpoint']));
  assert.equal(outcome.status, 'captured'); assert.equal(h.calls[0][1].active, false);
  assert.deepEqual(h.calls.at(-1), ['remove', 400]); assert.equal(h.entry.temporaryTabs[0].cleanup, 'closed');
});
test('user-activated, pinned or navigated temporary tab is preserved', async () => {
  for (const [changes, reason] of [[{ active: true }, 'kept_active'], [{ pinned: true }, 'kept_pinned'], [{ url: 'https://example.org/' }, 'kept_navigated']]) {
    const h = tabsHarness(changes); await withHistoryTab(h.entry, h.tabs, async () => ({ status: 'error' }));
    assert.ok(!h.calls.some(call => call[0] === 'remove')); assert.equal(h.entry.temporaryTabs[0].cleanup, reason);
  }
});
test('capture or storage failure still cleans up the new tab', async () => {
  const h = tabsHarness();
  await assert.rejects(withHistoryTab(h.entry, h.tabs, async () => { throw new Error('quota'); }), /quota/);
  assert.deepEqual(h.calls.at(-1), ['remove', 400]);
  const h2 = tabsHarness();
  await assert.rejects(withHistoryTab(h2.entry, h2.tabs, async () => ({ status: 'captured' }), async () => { throw new Error('save'); }), /save/);
  assert.deepEqual(h2.calls.at(-1), ['remove', 400]);
});
test('resume never cleans up old IDs that may have been reused after restart', async () => {
  const h = tabsHarness(); h.entry.temporaryTabs.push({ tabId: 99, cleanup: 'pending' });
  await withHistoryTab(h.entry, h.tabs, async () => ({ status: 'captured' }));
  assert.ok(h.calls.every(call => call[1] !== 99)); assert.equal(h.entry.temporaryTabs[0].cleanup, 'pending');
});
test('tab creation failure is a retryable error without a successful capture', async () => {
  const h = tabsHarness(); h.tabs.create = async () => { throw new Error('create'); };
  const result = await withHistoryTab(h.entry, h.tabs, async () => assert.fail('must not run'));
  assert.equal(result.status, 'error'); assert.equal(result.reason, 'tab_creation_failed');
});
test('URL export carries coverage, and history backup ZIP distinguishes current content', async () => {
  const result = await discoverHistory(async () => [link(1, 50)], period);
  const linkFiles = historyLinkFiles(result);
  assert.equal(linkFiles[0].data, `${origin}/doc/1\n`);
  assert.equal(JSON.parse(linkFiles[1].data).coverage, 'complete');
  const entries = historyEntries(result.links, () => 'entry');
  const files = await archiveFiles({ source: 'history', createdAt: '2026-10-09', entries, historySearch: result }, async () => undefined);
  assert.ok(files.some(file => file.name === 'delta-links.txt'));
  assert.match(files.find(file => file.name === 'index.txt').data, /Это текущий текст/);
  assert.equal(JSON.parse(files.find(file => file.name === 'report.json').data).entries[0].folder.startsWith('История/'), true);
});


test('history filename uses the browser-local last-visit day across the UTC midnight boundary', () => {
  const moduleUrl = new URL('../extension/archive.js', import.meta.url).href;
  const source = `
    import {archiveFiles} from ${JSON.stringify(moduleUrl)};
    const lastVisitTime = Date.parse('2026-10-09T21:30:00Z');
    const files = await archiveFiles({source:'history',createdAt:'2030-01-01',entries:[{source:'history',url:'https://delta.yandex-team.ru/synthetic/night',captureId:'c',status:'captured',lastVisitTime}]},async()=>({text:'\\n== Ночная заметка\\nТело без изменений',samples:[]}));
    console.log(JSON.stringify(files.filter(file=>file.name.startsWith('Чистые/'))));
  `;
  for (const [zone, day] of [['Europe/Moscow','2026-10-10'],['America/New_York','2026-10-09']]) {
    const result = spawnSync(process.execPath, ['--input-type=module','-e',source], {env:{...process.env,TZ:zone},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout),[{name:`Чистые/${day} - == Ночная заметка.md`,data:'\n== Ночная заметка\nТело без изменений'}]);
  }
});

test('dated history names deduplicate within a day, preserve separate days and leave tab filenames unchanged', async () => {
  const times = [Date.parse('2026-10-09T12:00:00Z'),Date.parse('2026-10-09T12:00:00Z'),Date.parse('2026-10-10T12:00:00Z')];
  const run = {source:'history',createdAt:'2030-01-01',entries:[
    ...times.map((lastVisitTime,i)=>({url:`https://delta.yandex-team.ru/synthetic/${i}`,status:i===1?'timeout':'captured',captureId:`c${i}`,lastVisitTime})),
    {source:'open_tabs',url:'https://delta.yandex-team.ru/synthetic/tab',status:'captured',captureId:'c3',lastVisitTime:times[0]}
  ]};
  const text='Первая строка\r\nТело **без изменений**\r\n';
  const files=await archiveFiles(run,async id=>({text,samples:[],partial:id==='c1'}));
  const day=time=>new Intl.DateTimeFormat('sv-SE',{year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(time));
  const clean=files.filter(file=>file.name.startsWith('Чистые/'));
  assert.deepEqual(clean.map(file=>file.name),[
    `Чистые/${day(times[0])} - Первая строка.md`,
    `Чистые/${day(times[0])} - Первая строка (2).md`,
    `Чистые/${day(times[2])} - Первая строка.md`,
    'Чистые/Первая строка.md'
  ]);
  assert.ok(clean.every(file=>file.data===text));
  const report=JSON.parse(files.find(file=>file.name==='report.json').data);
  assert.equal(report.entries[1].textFile.endsWith('/partial.txt'),true);
  assert.ok(report.entries.every(entry=>entry.cleanTitle==='Первая строка'));
  assert.equal(run.entries[0].cleanFile,undefined);
  await writeFile(new URL('./history-dated-fixture.zip',import.meta.url),new Uint8Array(await createZip(files).arrayBuffer()));
});

test('missing or invalid last-visit dates never invent the backup creation date or epoch', async () => {
  const invalid=[undefined,null,0,-1,NaN,Infinity,8640000000000001,'100'];
  const run={source:'history',createdAt:'2030-01-01',entries:invalid.map((lastVisitTime,i)=>({captureId:`c${i}`,lastVisitTime,status:'captured'}))};
  const files=await archiveFiles(run,async()=>({text:'Заметка\nИсходный текст',samples:[]}));
  const clean=files.filter(file=>file.name.startsWith('Чистые/'));
  assert.equal(clean.length,invalid.length);
  assert.equal(new Set(clean.map(file=>file.name)).size,invalid.length);
  assert.ok(clean.every(file=>file.name.startsWith('Чистые/Дата неизвестна - Заметка')));
  assert.ok(clean.every(file=>file.data==='Заметка\nИсходный текст'));
});
