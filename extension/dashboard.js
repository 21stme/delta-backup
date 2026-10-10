import { isDelta, VERSION, statusLabel, reasons } from './core.js';
import { entryState, pageCounts, filterEntries } from './ui-state.js';
import { saveRun, readStore, listRuns } from './storage.js';
import { captureTab, nextEntry, makeChromeAdapter } from './engine.js';
import { archiveFiles } from './archive.js';
import { createZip } from './zip.js';
import { runBatch, createRunWriter } from './queue.js';
import { restartBackup } from './restart.js';
import { goToOriginalTab } from './navigation.js';
import { historyPeriod, discoverHistory, historyEntries, withHistoryTab, historyLimitations, historyLinkFiles } from './browser-history.js';

const $ = id => document.getElementById(id);
const api = makeChromeAdapter();
const settingIds = ['timeout', 'stable', 'retries', 'maxReloads', 'concurrency', 'contentSelector', 'readySelector', 'loadingSelector'];
let run;
let working = false;
let activity = 'idle';
let sourceMode = 'open_tabs';
let resultFilter = 'all';
let searchQuery = '';
const expandedRows = new Set();
let pauseRequested = false;
let detail = '';
let persistRun = createRunWriter(saveRun, () => run);
const runningEntries = new Map();
let downloadId;
let downloadTarget = 'backup';
let historyResult;
let selectedHistory = new Set();
let scanningHistory = false;
let cancelHistory = false;
const fail = error => { $('error').textContent = error?.message || String(error); };

function getSettings() {
  const settings = {};
  for (const id of settingIds) settings[id] = $(id).value.trim();
  for (const [id, low, high] of [['timeout', 10, 1800], ['stable', 3, 120], ['retries', 0, 5], ['maxReloads', 0, 5], ['concurrency', 1, 10]]) {
    const value = Number(settings[id]);
    if (!Number.isInteger(value) || value < low || value > high) throw new Error(`Проверьте настройку «${$(id).parentElement.firstChild.textContent.trim()}».`);
    settings[id] = value;
  }
  if (settings.timeout < settings.stable + 5) throw new Error('Лимит ожидания должен быть не меньше периода стабильности плюс 5 секунд.');
  // Validate syntax locally. Existence is checked in the source page.
  for (const id of ['contentSelector', 'readySelector', 'loadingSelector']) {
    if (!settings[id]) continue;
    try { document.querySelector(settings[id]); } catch { throw new Error('Некорректный CSS-селектор: ' + id); }
  }
  return settings;
}

function showSettings(settings) {
  for (const id of settingIds) {
    $(id).value = settings[id] ?? (({ timeout: 15, stable: 3, retries: 1, maxReloads: 3, concurrency: 3 })[id] ?? '');
  }
}

function updateControls() {
  const counts = pageCounts(run?.entries);
  const backupRunning = working && activity === 'backup';
  const canResume = run && run.state !== 'finished' && nextEntry(run);
  $('openSource').hidden = sourceMode !== 'open_tabs';
  $('historySource').hidden = sourceMode !== 'history';
  $('start').hidden = sourceMode !== 'open_tabs';
  $('historyBackup').hidden = sourceMode !== 'history';
  $('sourceTabs').setAttribute('aria-pressed', String(sourceMode === 'open_tabs'));
  $('sourceHistory').setAttribute('aria-pressed', String(sourceMode === 'history'));
  $('sourceTabs').disabled = $('sourceHistory').disabled = working;
  $('start').disabled = working;
  $('restart').hidden = !run || working;
  $('restart').disabled = working || !run;
  $('pause').hidden = !backupRunning;
  $('pause').disabled = !backupRunning || pauseRequested;
  $('pause').textContent = pauseRequested ? 'Завершаю шаг…' : 'Приостановить';
  $('resume').hidden = working || !canResume;
  $('resume').disabled = working || !canResume;
  $('retryFailed').hidden = working || !counts.retryable;
  $('retryFailed').disabled = working || !counts.retryable;
  $('retryFailed').textContent = `Повторить неудачные · ${counts.retryable}`;
  $('export').disabled = working || !run;
  $('history').disabled = working || !run;
  $('groups').disabled = working;
  $('historyScan').disabled = working;
  $('historyScan').hidden = scanningHistory;
  $('historySearchStop').hidden = !scanningHistory;
  $('historySearchStop').disabled = !scanningHistory || cancelHistory;
  $('historyExport').disabled = working || !historyResult;
  $('historyBackup').disabled = working || !historyResult || !selectedHistory.size;
  $('historyBackup').textContent = selectedHistory.size ? `Бэкап выбранных ссылок · ${selectedHistory.size}` : 'Бэкап выбранных ссылок';
  $('historySelection').hidden = !historyResult?.links.length;
  $('historySelectAll').disabled = working || !historyResult?.links.length;
  $('historySelectNone').disabled = working || !selectedHistory.size;
  for (const id of ['historyRange', 'historyFrom', 'historyTo']) $(id).disabled = working;
  for (const checkbox of $('historyLinks').querySelectorAll('input')) checkbox.disabled = working;
  for (const id of settingIds) $(id).disabled = working;
  $('settingsSummary').textContent = `Ожидание ${$('timeout').value || '—'} с · Без изменений ${$('stable').value || '—'} с · Повторов ${$('retries').value || '0'} · Перезагрузок ${$('maxReloads').value || '0'}`;
  for (const [id, value] of [['filterAll', 'all'], ['filterSaved', 'saved'], ['filterProblems', 'problems']]) {
    $(id).disabled = !run;
    $(id).setAttribute('aria-pressed', String(resultFilter === value));
  }
  $('resultSearch').disabled = !run;
}

function backupLabel(item) {
  return `${new Date(item.createdAt).toLocaleString('ru-RU')} · ${item.source === 'history' ? 'из истории' : 'открытые вкладки'} · Страниц: ${item.entries.length} · Сохранено: ${item.entries.filter(e => e.status === 'captured').length}`;
}

function render(full = true) {
  updateControls();
  $('emptyRun').hidden = Boolean(run);
  $('runContent').hidden = !run;
  if (!run) {
    $('status').textContent = 'Начните первый бэкап';
    return;
  }
  const counts = pageCounts(run.entries);
  const currentOption = [...$('history').options].find(option => option.value === run.id);
  if (currentOption) currentOption.textContent = backupLabel(run);
  $('runContext').textContent = `Бэкап · ${run.source === 'history' ? 'из истории' : 'открытые вкладки'} · ${new Date(run.createdAt).toLocaleString('ru-RU')}`;
  $('status').textContent = activity === 'export' ? 'Готовлю ZIP' : activity === 'backup' ? (pauseRequested ? 'Завершаю текущий шаг…' : 'Читаю страницы Delta') : run.state === 'finished' ? 'Обход завершён' : 'Бэкап приостановлен';
  for (const [id, field] of [['countSaved', 'saved'], ['countReading', 'reading'], ['countPending', 'pending'], ['countProblems', 'problems']]) {
    $(id).textContent = counts[field].toLocaleString('ru-RU');
    $(id).parentElement.classList.toggle('is-zero', counts[field] === 0);
  }
  $('progress').textContent = `Обработано ${counts.processed} из ${counts.total}`;
  $('runTotal').textContent = `Страниц в бэкапе: ${counts.total}`;
  $('runProgress').max = counts.total || 1;
  $('runProgress').value = counts.processed;
  $('liveDetails').hidden = activity !== 'backup' || !detail;
  $('progressDetails').textContent = detail;
  $('filterAll').textContent = `Все · ${counts.total}`;
  $('filterSaved').textContent = `Сохранённые · ${counts.saved}`;
  $('filterProblems').textContent = `Проблемы · ${counts.problems}`;
  if (!full) return;
  const visible = filterEntries(run.entries, resultFilter, searchQuery);
  $('filteredSummary').textContent = `Показано ${visible.length} из ${counts.total}`;
  $('emptyResults').hidden = visible.length > 0;
  $('rows').replaceChildren();
  for (const entry of visible) {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    const title = document.createElement('div'); title.className = 'document-title'; title.textContent = entry.title || 'Без названия'; name.append(title);
    const metadata = document.createElement('small');
    metadata.textContent = entry.source === 'history' ? `Из истории · последний визит: ${entry.lastVisitTime ? new Date(entry.lastVisitTime).toLocaleString('ru-RU') : 'неизвестен'}` : `Окно ${entry.windowId} · ${entry.groupTitle || (entry.groupId < 0 ? 'Без группы' : 'Группа ' + entry.groupId)}`; name.append(metadata);
    const rowDetails = document.createElement('details'); rowDetails.className = 'row-details';
    const summary = document.createElement('summary'); summary.textContent = 'Адрес и детали';
    const url = document.createElement('small'); url.className = 'document-url'; url.textContent = entry.url;
    const attempts = document.createElement('small'); attempts.textContent = `Попыток: ${entry.attempts || 0} · Перезагрузок: ${entry.reloadEvents?.length || 0}`;
    rowDetails.append(summary, url, attempts);
    const key = `${run.id}/${entry.id || entry.tabId || entry.index}`;
    rowDetails.open = expandedRows.has(key);
    rowDetails.addEventListener('toggle', () => { if (rowDetails.open) expandedRows.add(key); else expandedRows.delete(key); });
    name.append(rowDetails);
    const status = document.createElement('td');
    const badge = document.createElement('span'); badge.className = `status-badge ${entryState(entry)}`; badge.textContent = statusLabel(entry); status.append(badge);
    if (entry.reason) { const reason = document.createElement('small'); reason.textContent = reasons[entry.reason] || entry.reason; status.append(reason); }
    const importantWarnings = (entry.warnings || []).filter(warning => !['readiness_is_heuristic', 'editor_or_virtualized_content'].includes(warning) && !(warning === 'virtualized_content_unverified' && (entry.warnings || []).includes('ace_model_unavailable')));
    if (importantWarnings.length) {
      const warning = document.createElement('small'); warning.textContent = importantWarnings.map(code => reasons[code] || code).join('; '); status.append(warning);
    }
    const chars = document.createElement('td'); chars.textContent = Number.isFinite(entry.characters) ? `${entry.characters.toLocaleString('ru-RU')} симв.` : '—';
    const review = document.createElement('td');
    const actions = document.createElement('div'); actions.className = 'row-actions';
    if (entry.captureId) {
      const preview = document.createElement('button'); preview.textContent = 'Посмотреть'; preview.className = 'secondary';
      preview.addEventListener('click', () => previewCapture(entry).catch(fail)); actions.append(preview);
    }
    if (entry.source !== 'history' && Number.isInteger(entry.tabId)) {
      const source = document.createElement('button'); source.textContent = 'Перейти на вкладку'; source.className = 'secondary';
      source.addEventListener('click', () => goToOriginalTab(entry, chrome.tabs, chrome.windows).catch(fail)); actions.append(source);
    }
    review.append(actions); row.append(name, status, chars, review); $('rows').append(row);
  }
}

function resetResultView() {
  resultFilter = 'all'; searchQuery = ''; $('resultSearch').value = ''; expandedRows.clear();
}

async function withLock(task) {
  if (!navigator.locks) throw new Error('В этой версии браузера отсутствует Web Locks. Обход не запущен, чтобы исключить одновременную запись.');
  return navigator.locks.request('delta-backup-run', { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('Бэкап уже работает в другой панели. Откройте её или закройте, чтобы продолжить здесь.');
    return task();
  });
}

async function inventory(settings) {
  const tabs = (await chrome.tabs.query({})).filter(tab => !tab.incognito && isDelta(tab.pendingUrl || tab.url));
  if (!tabs.length) throw new Error('Открытые вкладки Delta не найдены. Проверьте профиль браузера: расширение видит вкладки только своего профиля.');
  const groupMap = new Map();
  let groupCoverage = 'id_only';
  try {
    if (chrome.tabGroups && await chrome.permissions.contains({ permissions: ['tabGroups'] })) {
      for (const group of await chrome.tabGroups.query({})) groupMap.set(group.id, group);
      groupCoverage = 'names_available';
    }
  } catch { groupCoverage = 'api_unavailable'; }
  tabs.sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  const createdAt = new Date().toISOString();
  return {
    id: `${createdAt.replace(/[:.]/g, '-')}-${crypto.randomUUID()}`, createdAt, updatedAt: createdAt,
    version: VERSION, source: 'open_tabs', state: 'paused', settings, groupCoverage,
    scope: 'open tabs in this browser profile at start; incognito excluded',
    entries: tabs.map(tab => ({
      tabId: tab.id, windowId: tab.windowId, index: tab.index, groupId: tab.groupId ?? -1,
      groupTitle: groupMap.get(tab.groupId)?.title || '', groupCollapsed: groupMap.get(tab.groupId)?.collapsed ?? null,
      groupColor: groupMap.get(tab.groupId)?.color || null,
      title: tab.title || '', url: tab.pendingUrl || tab.url, discardedAtStart: Boolean(tab.discarded),
      status: 'pending', attempts: 0, reviewed: false
    }))
  };
}

async function refreshHistory() {
  const runs = await listRuns();
  $('history').replaceChildren();
  for (const item of runs) {
    const option = document.createElement('option'); option.value = item.id;
    option.textContent = backupLabel(item);
    $('history').append(option);
  }
  if (run) $('history').value = run.id;
  if (!runs.length) { const option = document.createElement('option'); option.textContent = 'Бэкапов пока нет'; $('history').append(option); }
}

async function persistCapture(entry, outcome, final = false) {
  const capture = outcome.capture ? { ...outcome.capture, id: entry.activeCaptureId } : undefined;
  await persistRun(capture, () => {
    if (capture) {
      entry.captureId = capture.id; entry.characters = capture.text.length; entry.warnings = capture.warnings;
    }
    if (final) {
      if (outcome.status === 'paused') {
        entry.status = 'pending'; entry.attempts = Math.max(0, entry.attempts - 1); entry.reason = undefined;
      } else {
        entry.status = outcome.status; entry.reason = outcome.reason; entry.completedAt = new Date().toISOString();
      }
    }
  });
}

function progressDetail() {
  detail = [...runningEntries.values()].filter(Boolean).join(' · ');
}

async function runLoop() {
  persistRun = createRunWriter(saveRun, () => run);
  await persistRun(undefined, () => { run.state = 'running'; }); render();
  try {
    while (!pauseRequested && nextEntry(run)) {
      const pending = run.entries.filter(entry => ['pending', 'waiting'].includes(entry.status));
      const batch = pending.length ? pending : run.entries.filter(entry => nextEntry({ settings: run.settings, entries: [entry] }));
      await runBatch(batch, run.settings.concurrency ?? 3, async (entry, stopped) => {
        runningEntries.set(entry, '');
        try {
          await persistRun(undefined, () => {
            entry.status = 'waiting'; entry.attempts++; entry.reason = undefined;
            entry.activeCaptureId = `${run.id}/entry-${entry.id || entry.tabId}/${crypto.randomUUID()}`;
          }); render();
          const capture = () => captureTab(entry, run.settings, {
            api, paused: () => pauseRequested || stopped(),
            onProgress: async progress => {
              runningEntries.set(entry, `Страница ${entry.index + 1}: ${progress.elapsed}/${progress.waitLimit} с; попытка ${entry.attempts}; перезагрузок ${progress.reloads}`);
              progressDetail(); render(false);
            },
            onReload: event => persistRun(undefined, () => { (entry.reloadEvents ||= []).push({ ...event, attempt: entry.attempts }); }),
            checkpoint: outcome => persistCapture(entry, outcome)
          });
          const outcome = entry.source === 'history' ? await withHistoryTab(entry, chrome.tabs, capture, () => persistRun()) : await capture();
          await persistCapture(entry, outcome, true);
        } finally {
          runningEntries.delete(entry); progressDetail(); render();
        }
      }, { paused: () => pauseRequested });
    }
    await persistRun(undefined, () => { run.state = nextEntry(run) ? 'paused' : 'finished'; });
  } finally {
    runningEntries.clear(); detail = '';
  }
}

async function begin(mode) {
  if (working) return;
  $('error').textContent = ''; $('archiveStatus').textContent = ''; pauseRequested = false; working = true; activity = 'backup'; updateControls();
  try {
    await withLock(async () => {
      const settings = getSettings();
      if (mode === 'new') { run = await inventory(settings); await saveRun(run); }
      else if (mode === 'restart') {
        const previous = await readStore('runs', run.id);
        run = await restartBackup(previous, settings, inventory);
        await saveRun(run);
      }
      else if (mode === 'history') {
        if (!historyResult || !selectedHistory.size) throw new Error('Сначала найдите и выберите ссылки Delta из истории.');
        const createdAt = new Date().toISOString();
        const entries = historyEntries(historyResult.links.filter(link => selectedHistory.has(link.url)));
        if (!entries.length) throw new Error('Подходящие ссылки не выбраны.');
        run = {
          id: `${createdAt.replace(/[:.]/g, '-')}-${crypto.randomUUID()}`, createdAt, updatedAt: createdAt,
          version: VERSION, source: 'history', state: 'paused', settings, entries, groupCoverage: 'not_in_browser_history',
          scope: 'current content of selected URLs from available browser history',
          historySearch: { ...historyResult, links: undefined, found: historyResult.links.length, selected: entries.length }
        };
        await saveRun(run);
      }
      else {
        run = await readStore('runs', run.id);
        run.settings = settings;
        if (mode === 'retry') {
          for (const entry of run.entries) if (['timeout', 'error'].includes(entry.status)) {
            entry.status = 'pending'; entry.attempts = 0; entry.reason = undefined; entry.reviewed = false;
          }
        }
        // Interrupted attempts restart with the same retry allowance.
        for (const entry of run.entries) if (entry.status === 'waiting') { entry.status = 'pending'; entry.attempts = Math.max(0, entry.attempts - 1); }
      }
      if (['new', 'restart', 'history'].includes(mode)) resetResultView();
      showSettings(run.settings); await refreshHistory(); await runLoop();
    });
  } catch (error) {
    fail(error);
    if (run) {
      // Reload the durable checkpoint instead of reporting unsaved successes.
      const stored = await readStore('runs', run.id).catch(() => undefined);
      if (stored) run = stored;
      run.state = 'paused';
    }
  } finally {
    working = false; activity = 'idle'; detail = ''; render(); await refreshHistory().catch(fail);
  }
}

async function previewCapture(entry) {
  const capture = await readStore('captures', entry.captureId);
  if (!capture) throw new Error('Снимок не найден');
  // text/plain: page text cannot execute HTML or scripts in the preview.
  const url = URL.createObjectURL(new Blob([capture.text], { type: 'text/plain;charset=utf-8' }));
  try { await chrome.tabs.create({ url }); } finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
}

async function exportRun() {
  if (working || !run) return;
  working = true; activity = 'export'; render(false); $('error').textContent = '';
  try {
    await withLock(async () => {
      run = await readStore('runs', run.id);
      const files = await archiveFiles(run, id => readStore('captures', id));
      const stamp = run.createdAt.slice(0, 19).replace(/[:T]/g, '-');
      await downloadFiles(files, `delta-${run.source === 'history' ? 'history-' : ''}backup-${stamp}.zip`);
    });
  } catch (error) { fail(error); }
  finally { working = false; activity = 'idle'; render(); }
}

async function downloadFiles(files, filename, target = 'backup') {
  const blob = createZip(files);
  // Keep each download's URL alive until that download finishes.
  const url = URL.createObjectURL(blob);
  try { downloadId = await chrome.downloads.download({ url, filename, saveAs: true, conflictAction: 'uniquify' }); }
  catch (error) { URL.revokeObjectURL(url); throw error; }
  downloadTarget = target;
  downloadUrls.set(downloadId, url);
  const [download] = await chrome.downloads.search({ id: downloadId });
  if (['complete', 'interrupted'].includes(download?.state)) { URL.revokeObjectURL(url); downloadUrls.delete(downloadId); }
  if (download?.state === 'interrupted') throw new Error('Загрузка ZIP прервана или отменена. Повторите выгрузку.');
  detail = download?.state === 'complete' ? 'ZIP сохранён браузером.' : 'ZIP передан браузеру. Дождитесь завершения в списке загрузок.';
  if (target === 'history_links') $('historyDownloadStatus').textContent = detail;
  else $('archiveStatus').textContent = detail;
}
const downloadUrls = new Map();

function renderHistoryLinks() {
  $('historyLinks').replaceChildren();
  if (!historyResult) { updateControls(); return; }
  const limits = historyResult.limitations.map(code => historyLimitations[code] || code);
  $('historySummary').textContent = `Найдено ${historyResult.links.length} уникальных ссылок · Выбрано ${selectedHistory.size} · ${historyResult.coverage === 'complete' ? 'Поиск завершён в выбранном периоде доступной истории' : 'Поиск НЕПОЛНЫЙ: ' + limits.join('; ')}`;
  for (const link of historyResult.links) {
    const label = document.createElement('label'); label.className = 'history-link';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selectedHistory.has(link.url);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedHistory.add(link.url); else selectedHistory.delete(link.url);
      // Keep focus and scroll position; only the count and controls change.
      $('historySummary').textContent = `Найдено ${historyResult.links.length} уникальных ссылок · Выбрано ${selectedHistory.size} · ${historyResult.coverage === 'complete' ? 'Поиск завершён' : 'Поиск НЕПОЛНЫЙ: ' + limits.join('; ')}`;
      updateControls();
    });
    label.append(checkbox, document.createTextNode(link.title || link.url));
    const url = document.createElement('small'); url.textContent = link.url; label.append(url);
    const visit = document.createElement('small'); visit.textContent = link.lastVisitTime ? 'Последний визит: ' + new Date(link.lastVisitTime).toLocaleString('ru-RU') : 'Время визита неизвестно'; label.append(visit);
    $('historyLinks').append(label);
  }
  updateControls();
}

async function scanHistory() {
  if (working) return;
  $('error').textContent = '';
  let period;
  try { period = historyPeriod($('historyRange').value, $('historyFrom').value, $('historyTo').value); } catch (error) { fail(error); return; }
  // Request synchronously from this button's user gesture, before any awaited work.
  let permission;
  try { permission = chrome.permissions.request({ permissions: ['history'] }); } catch (error) { fail(error); return; }
  working = true; activity = 'scan'; scanningHistory = true; cancelHistory = false;
  historyResult = undefined; selectedHistory.clear(); renderHistoryLinks();
  $('historySummary').textContent = 'Ожидаю доступ к истории…';
  $('historyDownloadStatus').textContent = '';
  try {
    if (!await permission) throw new Error('Доступ к истории не выдан. Поиск не выполнялся.');
    if (!chrome.history?.search) throw new Error('Этот браузер не предоставляет API истории.');
    historyResult = await discoverHistory(query => chrome.history.search(query), period, {
      cancelled: () => cancelHistory,
      onProgress: async state => { $('historySummary').textContent = `Поиск истории: найдено ${state.found} · запросов ${state.calls}`; }
    });
    selectedHistory = new Set(historyResult.links.map(link => link.url));
    renderHistoryLinks();
  } catch (error) { $('historySummary').textContent = 'Поиск не выполнен. Смотрите сообщение об ошибке.'; fail(error); }
  finally { working = false; activity = 'idle'; scanningHistory = false; updateControls(); }
}

async function exportHistoryLinks() {
  if (working || !historyResult) return;
  working = true; updateControls(); $('error').textContent = '';
  try { await downloadFiles(historyLinkFiles(historyResult), `delta-history-links-${historyResult.scannedAt.slice(0, 19).replace(/[:T]/g, '-')}.zip`, 'history_links'); }
  catch (error) { fail(error); }
  finally { working = false; updateControls(); }
}

chrome.downloads.onChanged.addListener(change => {
  if (change.state?.current === 'complete' || change.state?.current === 'interrupted') {
    const url = downloadUrls.get(change.id);
    if (url) { URL.revokeObjectURL(url); downloadUrls.delete(change.id); }
  }
  if (change.id !== downloadId) return;
  if (change.state?.current === 'complete') {
    detail = 'ZIP сохранён браузером.';
    if (downloadTarget === 'history_links') $('historyDownloadStatus').textContent = detail;
    else { $('archiveStatus').textContent = detail; render(false); }
  } else if (change.state?.current === 'interrupted') {
    fail(new Error('Загрузка ZIP прервана или отменена. Нажмите «Скачать ZIP» ещё раз.'));
  }
});

$('groups').addEventListener('click', async () => {
  try {
    if (!chrome.tabGroups) throw new Error('Этот браузер не предоставляет API групп. ID групп и окна всё равно будут сохранены.');
    const granted = await chrome.permissions.request({ permissions: ['tabGroups'] });
    $('groups').textContent = granted ? 'Названия групп разрешены' : 'Разрешение групп не выдано';
  } catch (error) { fail(error); }
});
$('settingsToggle').addEventListener('click', () => {
  $('settingsPanel').hidden = !$('settingsPanel').hidden;
  $('settingsToggle').setAttribute('aria-expanded', String(!$('settingsPanel').hidden));
});
$('sourceTabs').addEventListener('click', () => { sourceMode = 'open_tabs'; updateControls(); });
$('sourceHistory').addEventListener('click', () => { sourceMode = 'history'; updateControls(); });
for (const [id, filter] of [['filterAll', 'all'], ['filterSaved', 'saved'], ['filterProblems', 'problems']]) $(id).addEventListener('click', () => { resultFilter = filter; render(); });
$('resultSearch').addEventListener('input', () => { searchQuery = $('resultSearch').value; render(); });
for (const id of settingIds) $(id).addEventListener('input', updateControls);
$('start').addEventListener('click', () => begin('new'));
$('restart').addEventListener('click', () => begin('restart'));
$('historyScan').addEventListener('click', scanHistory);
$('historyBackup').addEventListener('click', () => begin('history'));
$('historyExport').addEventListener('click', exportHistoryLinks);
$('historySearchStop').addEventListener('click', () => { cancelHistory = true; updateControls(); });
$('historySelectAll').addEventListener('click', () => { selectedHistory = new Set(historyResult.links.map(link => link.url)); renderHistoryLinks(); });
$('historySelectNone').addEventListener('click', () => { selectedHistory.clear(); renderHistoryLinks(); });
$('historyRange').addEventListener('change', () => { $('historyDates').hidden = $('historyRange').value !== 'custom'; });
$('resume').addEventListener('click', () => begin('resume'));
$('retryFailed').addEventListener('click', () => begin('retry'));
$('pause').addEventListener('click', () => { pauseRequested = true; render(false); });
$('export').addEventListener('click', exportRun);
$('history').addEventListener('change', async () => {
  try { run = await readStore('runs', $('history').value); showSettings(run.settings); detail = ''; $('archiveStatus').textContent = ''; resetResultView(); render(); } catch (error) { fail(error); }
});

async function init() {
  $('extensionVersion').textContent = `v${VERSION}`;
  const runs = await listRuns();
  if (runs.length) run = runs[0];
  await refreshHistory(); render();
  try { if (await chrome.permissions.contains({ permissions: ['tabGroups'] })) $('groups').textContent = 'Названия групп разрешены'; } catch {}
}
init().catch(fail);
