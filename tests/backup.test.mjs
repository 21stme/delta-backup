import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { captureTab, nextEntry, makeChromeAdapter } from '../extension/engine.js';
import { isDelta, safeName, samePage, capturePath } from '../extension/core.js';
import { archiveFiles } from '../extension/archive.js';
import { createZip, crc32 } from '../extension/zip.js';

const sourceUrl = 'https://delta.yandex-team.ru/document?id=7#source';
const settings = { timeout: 30, stable: 3, retries: 1, contentSelector: '', readySelector: '', loadingSelector: '' };
const entry = { tabId: 7, windowId: 1, groupId: 3, groupTitle: 'Группа / тест', index: 0, url: sourceUrl, title: 'Текст <script>', status: 'pending', attempts: 0 };
function harness(custom = {}) {
  let clock = 0;
  const calls = [], checkpoints = [];
  const snapshot = () => ({ url: sourceUrl, title: 'Тест', readyState: 'complete', busy: false, atBottom: true, frames: [{ frame: 'main', text: 'Полный текст', scrollPositions: [] }], warnings: [] });
  const api = {
    async getTab() { return custom.tab ? custom.tab(clock) : { url: sourceUrl, status: clock < (custom.loadUntil || 0) ? 'loading' : 'complete', discarded: Boolean(custom.discarded && !calls.includes('reload')) }; },
    async reload() { calls.push('reload'); custom.onReload?.(clock); },
    async activate() { calls.push('activate'); return 2; },
    async restoreActive() { calls.push('restore-active'); },
    async snapshot(id, opts, ...actions) {
      assert.equal(actions.length, 0);
      calls.push('read');
      if (custom.throwRead) throw new Error('Blocked');
      const snap = custom.snapshot ? custom.snapshot(clock) : snapshot();
      return { snapshot: snap, editors: typeof custom.editors === 'function' ? custom.editors(clock) : custom.editors || [] };
    }
  };
  return {
    api, calls, checkpoints,
    now: () => clock, paused: () => custom.pauseAt !== undefined && clock >= custom.pauseAt,
    sleep: async ms => { clock += ms; }, pollMs: 1000,
    checkpoint: async value => { if (custom.failCheckpoint) throw new Error('QuotaExceededError'); checkpoints.push(structuredClone(value)); }
  };
}
const plainSnapshot = (text, extra = {}) => ({ url: sourceUrl, title: 'Тест', readyState: 'complete', busy: false, atBottom: true, frames: [{ frame: 'main', text, scrollPositions: [] }], warnings: [], ...extra });

test('slow tab: no capture until browser load + text stability', async () => {
  const h = harness({ loadUntil: 9000 });
  const result = await captureTab(entry, settings, h);
  assert.equal(result.status, 'captured');
  assert.ok(h.now() >= 12000);
  assert.equal(result.capture.partial, false);
  assert.equal(result.capture.completeness, 'unverified');
});
test('stable shell with loader must never count as success', async () => {
  const h = harness({ snapshot: () => plainSnapshot('Delta: оболочка', { busy: true }) });
  const result = await captureTab(entry, settings, h);
  assert.equal(result.status, 'timeout'); assert.equal(result.capture.partial, true);
});
test('Delta loader can disappear long after browser reports complete', async () => {
  const h = harness({ snapshot: ms => plainSnapshot(ms < 17000 ? 'Оболочка' : 'ЗАГРУЖЕННЫЙ ДОКУМЕНТ', { busy: ms < 17000 }) });
  const result = await captureTab(entry, settings, h);
  assert.equal(result.status, 'captured'); assert.ok(h.now() >= 20000);
  assert.equal(result.capture.text, 'ЗАГРУЖЕННЫЙ ДОКУМЕНТ');
});
test('changing content resets stability timer', async () => {
  const h = harness({ snapshot: ms => plainSnapshot(ms < 6000 ? String(ms) : 'Финал') });
  const result = await captureTab(entry, settings, h);
  assert.equal(result.status, 'captured'); assert.ok(h.now() >= 9000);
});
test('empty document and loading-only text time out', async () => {
  for (const text of ['', 'Загрузка…', 'Loading...']) {
    const result = await captureTab(entry, settings, harness({ snapshot: () => plainSnapshot(text) }));
    assert.equal(result.status, 'timeout');
  }
});
test('discarded tab wakes once; loaded tab never reloads', async () => {
  const discarded = harness({ discarded: true }); await captureTab(entry, settings, discarded);
  assert.equal(discarded.calls.filter(c => c === 'reload').length, 1);
  const loaded = harness(); await captureTab(entry, settings, loaded); assert.ok(!loaded.calls.includes('reload'));
});
test('closed and navigated tabs cannot back up the wrong document', async () => {
  const closed = harness({ tab: () => { throw new Error('closed'); } });
  assert.equal((await captureTab(entry, settings, closed)).status, 'closed');
  const navigated = harness({ tab: () => ({ url: sourceUrl.replace('id=7', 'id=8'), status: 'complete' }) });
  assert.equal((await captureTab(entry, settings, navigated)).status, 'navigated');
  assert.equal(navigated.calls.length, 0);
});
test('pending redirect checked before any read', async () => {
  const h = harness({ tab: () => ({ url: sourceUrl, pendingUrl: 'https://passport.yandex-team.ru/', status: 'loading' }) });
  assert.equal((await captureTab(entry, settings, h)).status, 'navigated'); assert.equal(h.calls.length, 0);
});
test('race: document URL changed between tab query and DOM read', async () => {
  const h = harness({ snapshot: () => plainSnapshot('Другой документ', { url: 'https://delta.yandex-team.ru/other' }) });
  const result = await captureTab(entry, settings, h);
  assert.equal(result.status, 'navigated'); assert.equal(result.capture, null);
});
test('legacy scroll and activate settings cannot move or activate a tab', async () => {
  const h = harness({ snapshot: () => plainSnapshot('Видимые строки', { atBottom: false, warnings: ['editor_or_virtualized_content', 'ace_model_unavailable'] }) });
  const result = await captureTab(entry, { ...settings, scroll: true, activate: true }, h);
  assert.equal(result.status, 'captured'); assert.ok(h.calls.every(action => action === 'read'));
  assert.equal(result.capture.extractionMethod, 'page_text');
  assert.ok(result.capture.warnings.includes('ace_model_unavailable'));
  assert.ok(result.capture.warnings.includes('virtualized_content_unverified'));
  assert.ok(!('scrollSteps' in result.capture)); assert.equal(result.capture.samples.length, 1);
});
test('pause preserves partial text while loading without moving the tab', async () => {
  const h = harness({ pauseAt: 6000, snapshot: () => plainSnapshot('Частичный текст', { busy: true }) });
  const result = await captureTab(entry, settings, h);
  assert.equal(result.status, 'paused'); assert.ok(result.capture.partial);
  assert.equal(result.capture.text, 'Частичный текст'); assert.ok(h.calls.every(action => action === 'read'));
});
test('checkpoint quota failure stops capture and is not reclassified as page success', async () => {
  const h = harness({ failCheckpoint: true });
  await assert.rejects(captureTab(entry, settings, h), error => error.checkpointFailure === true);
});
test('unreadable injection is an error, not an empty successful backup', async () => {
  assert.equal((await captureTab(entry, settings, harness({ throwRead: true }))).status, 'error');
});
test('hung browser injection cannot stall the whole backup indefinitely', async () => {
  const h = harness();
  h.api.snapshot = () => new Promise(() => {});
  const result = await captureTab(entry, settings, { ...h, callTimeoutMs: 5 });
  assert.equal(result.status, 'error'); assert.equal(result.reason, 'injection_failed');
});
test('tab lookup timeout is not evidence that the tab was closed', async () => {
  const h = harness(); h.api.getTab = () => new Promise(() => {});
  const result = await captureTab(entry, settings, { ...h, callTimeoutMs: 5 });
  assert.equal(result.status, 'error'); assert.equal(result.reason, 'browser_unresponsive');
});
test('auth, selector and page error are explicit failures', async () => {
  for (const reason of ['authentication_required', 'page_error']) {
    const result = await captureTab(entry, settings, harness({ snapshot: () => plainSnapshot('Shell', { warnings: [reason] }) }));
    assert.equal(result.status, 'error'); assert.equal(result.reason, reason);
  }
  const bad = await captureTab(entry, settings, harness({ snapshot: () => ({ error: 'invalid_selector' }) }));
  assert.equal(bad.reason, 'invalid_selector');
});
test('attached editor model is preserved beyond visible viewport', async () => {
  const result = await captureTab(entry, settings, harness({ editors: [{ kind: 'Monaco', text: 'ALL EDITOR LINES' }] }));
  assert.match(result.capture.text, /ALL EDITOR LINES/);
});
test('complete Ace source is preserved exactly rather than duplicated with its viewport', async () => {
  const full = '  исходный код\n\n' + Array.from({ length: 400 }, (_, i) => 'Строка ' + i).join('\n') + '\n';
  const h = harness({ editors: [{ kind: 'Ace', name: 'UNIQUE', text: full }], snapshot: () => plainSnapshot('  исходный код', { frames: [{ frame: 'main', text: '  исходный код', aceSourceOnly: true, aceEditorId: 'UNIQUE', scrollPositions: [] }] }) });
  const result = await captureTab(entry, settings, h);
  assert.equal(result.status, 'captured'); assert.equal(result.capture.text, full);
});
test('stable complete Ace model skips scrolling even when the viewport is not at the bottom', async () => {
  const full = Array.from({ length: 400 }, (_, i) => 'Строка ' + i).join('\n');
  for (const movingViewport of [false, true]) {
  const h = harness({ editors: [{ kind: 'Ace', name: 'SOURCE', text: full }], snapshot: ms => plainSnapshot('Видимая строка', {
    atBottom: false, warnings: ['editor_or_virtualized_content', 'ace_model_unavailable'],
    frames: [{ frame: 'main', text: 'Видимая строка', aceSourceOnly: true, aceEditorId: 'SOURCE', scrollPositions: [{ top: movingViewport ? ms : 0, height: 20000, viewport: 500 }] }]
  }) });
  const result = await captureTab(entry, { ...settings, scroll: true }, h);
  assert.equal(result.status, 'captured'); assert.equal(result.capture.text, full);
  assert.equal(result.capture.extractionMethod, 'ace_model');
  assert.ok(h.calls.every(action => action === 'read'));
  assert.ok(!result.capture.warnings.includes('ace_model_unavailable'));
  }
});
test('Ace DOM-only, mismatched model and additional frame are read without scrolling', async () => {
  for (const variant of ['dom', 'mismatch', 'iframe']) {
    const frame = { frame: 'main', text: 'Часть', aceSourceOnly: true, aceEditorId: 'SOURCE', scrollPositions: [] };
    const h = harness({ editors: variant === 'dom' ? [] : [{ kind: 'Ace', name: variant === 'mismatch' ? 'OTHER' : 'SOURCE', text: 'Текст модели' }],
      snapshot: () => plainSnapshot('Часть', { frames: variant === 'iframe' ? [frame, { frame: 'iframe', text: 'Другой текст', scrollPositions: [] }] : [frame] }) });
    const result = await captureTab(entry, { ...settings, scroll: true }, h);
    assert.equal(result.status, 'captured'); assert.ok(h.calls.every(action => action === 'read'), variant);
  }
});
test('complete Ace model still waits for app readiness and stable model content', async () => {
  const h = harness({
    editors: ms => [{ kind: 'Ace', name: 'SOURCE', text: ms < 12000 ? 'Версия ' + ms : 'Финал\n' }],
    snapshot: ms => plainSnapshot('Видимая строка', { busy: ms < 7000, frames: [{ frame: 'main', text: 'Видимая строка', aceSourceOnly: true, aceEditorId: 'SOURCE', scrollPositions: [] }] })
  });
  const result = await captureTab(entry, { ...settings, scroll: true }, h);
  assert.equal(result.status, 'captured'); assert.ok(h.now() >= 15000);
  assert.equal(result.capture.text, 'Финал\n'); assert.ok(!h.calls.includes('init-scroll'));
});
test('empty Ace model cannot bypass the meaningful text gate', async () => {
  const h = harness({ editors: [{ kind: 'Ace', name: 'SOURCE', text: '' }], snapshot: () => plainSnapshot('Панель редактора', { frames: [{ frame: 'main', text: 'Панель редактора', aceSourceOnly: true, aceEditorId: 'SOURCE', scrollPositions: [] }] }) });
  const result = await captureTab(entry, { ...settings, scroll: true }, h);
  assert.equal(result.status, 'timeout'); assert.equal(result.reason, 'deadline_empty_text');
});
test('unstable text timeout keeps the available partial text without scrolling', async () => {
  const h = harness({ snapshot: ms => plainSnapshot('Фрагмент ' + ms, { atBottom: false }) });
  const result = await captureTab(entry, settings, h);
  assert.equal(result.status, 'timeout'); assert.equal(result.reason, 'deadline_unstable_text');
  assert.equal(result.capture.text, 'Фрагмент 29000'); assert.ok(h.calls.every(action => action === 'read'));
  assert.equal(result.capture.partial, true);
});
test('loading, busy page, empty text and instability have distinct deadline reasons', async () => {
  const cases = [
    ['deadline_browser_loading', { loadUntil: 40000 }],
    ['deadline_page_loading', { snapshot: () => plainSnapshot('Оболочка', { busy: true }) }],
    ['deadline_empty_text', { snapshot: () => plainSnapshot('Загрузка…') }],
    ['deadline_unstable_text', { snapshot: ms => plainSnapshot('Меняется ' + ms) }]
  ];
  for (const [reason, config] of cases) {
    const result = await captureTab(entry, { ...settings, maxReloads: 0 }, harness(config));
    assert.equal(result.status, 'timeout'); assert.equal(result.reason, reason);
  }
});
test('reload suggestion recovers a page before generic error handling', async () => {
  const h = harness();
  h.api.snapshot = async (id, opts, action) => ({ snapshot: plainSnapshot(h.calls.includes('reload') ? 'НАСТОЯЩИЙ КОНТЕНТ' : 'Попробуйте перезагрузить страницу', { warnings: h.calls.includes('reload') ? [] : ['page_error'] }), editors: [] });
  const events = [];
  const result = await captureTab(entry, settings, { ...h, onReload: async event => events.push(event) });
  assert.equal(result.status, 'captured'); assert.equal(result.capture.text, 'НАСТОЯЩИЙ КОНТЕНТ');
  assert.equal(result.reloads, 1); assert.equal(events.length, 1); assert.equal(result.capture.recoveryReloads, 1);
  assert.ok(result.capture.samples.every(sample => !sample.text.includes('перезагрузить')));
  assert.ok(!result.capture.warnings.includes('page_error'));
});
test('persistent reload suggestion cannot produce an infinite loop', async () => {
  const h = harness({ snapshot: () => plainSnapshot('ПОПРОБУЙТЕ\nПЕРЕЗАГРУЗИТЬ СТРАНИЦУ') });
  const result = await captureTab(entry, { ...settings, maxReloads: 2 }, h);
  assert.equal(result.status, 'error'); assert.equal(result.reason, 'reload_limit');
  assert.equal(h.calls.filter(call => call === 'reload').length, 2); assert.equal(result.capture.partial, true);
});
test('recovery message is actionable even before browser load completes', async () => {
  const h = harness({ loadUntil: 9000 });
  h.api.snapshot = async () => ({ snapshot: plainSnapshot(h.calls.includes('reload') ? 'ГОТОВЫЙ ТЕКСТ' : 'Попробуйте перезагрузить страницу'), editors: [] });
  const events = [];
  const result = await captureTab(entry, settings, { ...h, onReload: async event => events.push(event) });
  assert.equal(result.status, 'captured'); assert.equal(result.reloads, 1);
  assert.equal(events[0].at, new Date(0).toISOString()); assert.ok(h.now() >= 12000);
});
test('reload can be disabled; an explicit page-level signal works outside the selected text', async () => {
  const h = harness({ snapshot: () => plainSnapshot('Оболочка', { reloadSuggested: true }) });
  const result = await captureTab(entry, { ...settings, maxReloads: 0 }, h);
  assert.equal(result.reason, 'reload_limit'); assert.ok(!h.calls.includes('reload'));
});
test('loading timeout waits the full configured limit before each reload and renews the limit', async () => {
  const reloadAt = [], events = [];
  const h = harness({ loadUntil: 1000000, onReload: ms => reloadAt.push(ms) });
  const result = await captureTab(entry, { ...settings, timeout: 15, maxReloads: 3 }, { ...h, onReload: event => events.push(event) });
  assert.equal(result.status, 'timeout'); assert.equal(result.reason, 'deadline_browser_loading');
  assert.deepEqual(reloadAt, [15000, 30000, 45000]); assert.equal(h.now(), 60000);
  assert.equal(result.reloads, 3);
  assert.deepEqual(events.map(event => [event.previousWaitSeconds, event.nextWaitSeconds]), [[15, 15], [15, 15], [15, 15]]);
});
test('application loader receives the same wait-reload-wait sequence', async () => {
  const reloadAt = [];
  const h = harness({ snapshot: () => plainSnapshot('Оболочка', { busy: true }), onReload: ms => reloadAt.push(ms) });
  const result = await captureTab(entry, { ...settings, timeout: 15, maxReloads: 1 }, h);
  assert.deepEqual(reloadAt, [15000]); assert.equal(h.now(), 30000);
  assert.equal(result.status, 'timeout'); assert.equal(result.reason, 'deadline_page_loading');
});
test('late content after reload can use the renewed wait rather than the exhausted first deadline', async () => {
  const reloadAt = [];
  const h = harness({ loadUntil: 23000, onReload: ms => reloadAt.push(ms) });
  const result = await captureTab(entry, { ...settings, timeout: 15, maxReloads: 3 }, h);
  assert.equal(result.status, 'captured'); assert.deepEqual(reloadAt, [15000]);
  assert.ok(h.now() >= 26000 && h.now() < 30000);
});
test('a page requesting reload near the deadline also gets a fresh full wait', async () => {
  const h = harness({ snapshot: ms => ms < 14000 ? plainSnapshot('Загрузка', { busy: true }) : ms === 14000 ? plainSnapshot('Попробуйте перезагрузить страницу') : ms < 24000 ? plainSnapshot('Загрузка', { busy: true }) : plainSnapshot('Новый документ') });
  const result = await captureTab(entry, { ...settings, timeout: 15, maxReloads: 1 }, h);
  assert.equal(result.status, 'captured'); assert.equal(result.reloads, 1); assert.equal(h.now(), 27000);
});
test('zero reloads and pausing cannot trigger a reload at the deadline', async () => {
  const h = harness({ loadUntil: 100000 });
  const result = await captureTab(entry, { ...settings, timeout: 15, maxReloads: 0 }, h);
  assert.equal(result.status, 'timeout'); assert.equal(h.now(), 15000); assert.ok(!h.calls.includes('reload'));
  const paused = harness({ loadUntil: 100000, pauseAt: 15000 });
  assert.equal((await captureTab(entry, { ...settings, timeout: 15, maxReloads: 3 }, paused)).status, 'paused');
  assert.ok(!paused.calls.includes('reload'));
});
test('waking a discarded tab is followed by a full first waiting budget', async () => {
  const h = harness({ discarded: true });
  h.api.reload = async () => { h.calls.push('reload'); await h.sleep(14000); };
  const result = await captureTab(entry, { ...settings, timeout: 15 }, h);
  assert.equal(result.status, 'captured'); assert.equal(h.now(), 17000);
});
test('retry queue first finishes pending tabs and respects attempt limit', () => {
  const failed = { status: 'timeout', attempts: 1 }, pending = { status: 'pending', attempts: 0 };
  const run = { settings, entries: [failed, pending] };
  assert.equal(nextEntry(run), pending); pending.status = 'captured'; assert.equal(nextEntry(run), failed);
  failed.attempts = 2; assert.equal(nextEntry(run), undefined);
  failed.status = 'error'; failed.reason = 'authentication_required'; failed.attempts = 1; assert.equal(nextEntry(run), undefined);
});
test('strict origin and document identity include query and hash', () => {
  assert.ok(isDelta(sourceUrl));
  for (const url of ['http://delta.yandex-team.ru/', 'https://delta.yandex-team.ru.evil.org/', 'https://evil.org/?delta.yandex-team.ru']) assert.ok(!isDelta(url));
  assert.ok(!samePage(sourceUrl, sourceUrl.replace('#source', '#other')));
});
test('paths safe, Unicode kept, same title/URL tabs remain distinct', () => {
  assert.equal(safeName('../Пример/файл:*?'), '_Пример_файл___');
  assert.notEqual(capturePath(entry, 0), capturePath({ ...entry, tabId: 8 }, 1));
  assert.ok(!capturePath(entry, 0).split('/').includes('..'));
});
test('archive labels partial captures; missing saved capture aborts export', async () => {
  const run = { id: 'run', createdAt: new Date().toISOString(), settings, entries: [{ ...entry, status: 'timeout', captureId: 'c' }] };
  const capture = { id: 'c', text: 'Неполный текст', samples: [], partial: true };
  const files = await archiveFiles(run, async () => capture);
  assert.ok(files.some(file => file.name.endsWith('/partial.txt')));
  assert.ok(!files.some(file => file.name.endsWith('/text.txt')));
  const report = JSON.parse(files.find(file => file.name === 'report.json').data);
  assert.equal(report.summary.captured, 0); assert.equal(report.summary.failed, 1);
  await assert.rejects(archiveFiles(run, async () => undefined), /Не найден/);
});
test('ZIP STORE UTF-8 and CRC32; ZIP fixture readable independently by Python', async () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.throws(() => createZip([{ name: '../escape.txt', data: 'x' }]), /Некорректное/);
  const blob = createZip([{ name: 'Группа/документ.txt', data: 'Привет, Delta!\nСтрока 2\n' }, { name: 'empty.txt', data: '' }]);
  await writeFile(new URL('./archive-fixture.zip', import.meta.url), new Uint8Array(await blob.arrayBuffer()));
});

test('clean Markdown export is flat, includes unfinished saved text and preserves all raw bytes', async () => {
  const texts = ['\r\n== Заголовок Delta\r\n\r\nТело **без изменений**\r\n', 'Заголовок истории\nСписок:\n- пункт\n', 'Ожидание\nДоступный текст'];
  const captures = texts.map((text, i) => ({ id: `c${i}`, text, samples: [{ text: `Сырой снимок ${i}` }], partial: i === 2 }));
  const run = { id: 'clean', createdAt: '2026-10-10T08:00:00Z', entries: [
    { ...entry, title: 'Устаревшее название вкладки', status: 'captured', captureId: 'c0' },
    { ...entry, source: 'history', status: 'captured', captureId: 'c1' },
    { ...entry, status: 'timeout', captureId: 'c2' },
    { ...entry, status: 'error' }
  ] };
  const files = await archiveFiles(run, async id => captures.find(capture => capture.id === id));
  const clean = files.filter(file => file.name.startsWith('Чистые/'));
  assert.deepEqual(clean.map(file => file.name), ['Чистые/== Заголовок Delta.md', 'Чистые/Заголовок истории.md', 'Чистые/Ожидание.md']);
  assert.deepEqual(clean.map(file => file.data), texts);
  assert.ok(clean.every(file => file.name.split('/').length === 2));
  const report = JSON.parse(files.find(file => file.name === 'report.json').data);
  for (let i = 0; i < captures.length; i++) {
    assert.equal(files.find(file => file.name === report.entries[i].textFile).data, texts[i]);
    assert.deepEqual(JSON.parse(files.find(file => file.name === `${report.entries[i].folder}/capture.json`).data), captures[i]);
    assert.equal(files.find(file => file.name === `${report.entries[i].folder}/snapshots/001.txt`).data, captures[i].samples[0].text);
    assert.equal(report.entries[i].cleanFile, clean[i].name);
  }
  assert.equal(report.entries[3].cleanFile, undefined);
  assert.equal(run.entries[0].cleanFile, undefined);
  await writeFile(new URL('./clean-archive-fixture.zip', import.meta.url), new Uint8Array(await createZip(files).arrayBuffer()));
});

test('clean filenames handle duplicates, unsafe paths, Unicode normalization and truncation collisions', async () => {
  const titles = ['Название', 'название', 'Название (2)', '../путь/файл:*?', '..\\путь\\файл:*?', 'Café', 'Cafe\u0301', 'я'.repeat(100) + 'а', 'я'.repeat(100) + 'б'];
  const run = { id: 'names', entries: titles.map((title, i) => ({ ...entry, captureId: `c${i}`, status: 'captured' })) };
  const files = await archiveFiles(run, async id => ({ text: titles[Number(id.slice(1))], samples: [] }));
  const names = files.filter(file => file.name.startsWith('Чистые/')).map(file => file.name);
  assert.equal(new Set(names.map(name => name.normalize('NFC').toLowerCase())).size, titles.length);
  assert.equal(names[1], 'Чистые/название (2).md');
  assert.equal(names[2], 'Чистые/Название (2) (2).md');
  assert.equal(names[6], 'Чистые/Café (2).md');
  for (const name of names) {
    assert.equal(name.split('/').length, 2);
    assert.ok(!/[\\:*?"<>|\x00-\x1f]/.test(name));
    assert.ok(!name.split('/').includes('..'));
  }
});

test('empty saved text has a deterministic fallback title and is still exported', async () => {
  const run = { entries: [{ ...entry, title: 'Название вкладки', captureId: 'empty' }, { ...entry, title: '', captureId: 'blank' }] };
  const files = await archiveFiles(run, async id => ({ text: id === 'empty' ? '' : '\n\t\n', samples: [] }));
  assert.deepEqual(files.filter(file => file.name.startsWith('Чистые/')), [
    { name: 'Чистые/Название вкладки.md', data: '' }, { name: 'Чистые/Без названия.md', data: '\n\t\n' }
  ]);
});

test('native adapter only reads tabs and scripts; it never updates activation', async () => {
  const calls = [];
  globalThis.chrome = {
    tabs: { get: async () => ({ url: sourceUrl, status: 'complete' }), reload: async () => {}, update: () => assert.fail('No tab activation allowed') },
    scripting: { executeScript: async request => { calls.push(request); return [{ result: request.world === 'MAIN' ? [] : plainSnapshot('Текст') }]; } }
  };
  try {
    const api = makeChromeAdapter();
    assert.ok(!('activate' in api)); assert.ok(!('restoreActive' in api));
    const clock = harness();
    const result = await captureTab(entry, { ...settings, activate: true, scroll: true }, { ...clock, api });
    assert.equal(result.status, 'captured');
    assert.ok(calls.filter(call => call.world === 'ISOLATED').every(call => call.args.length === 1));
  } finally { delete globalThis.chrome; }
});
