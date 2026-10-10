import { isDelta, samePage, VERSION } from './core.js';

export function historyPeriod(kind, from = '', to = '', now = Date.now()) {
  if (kind === 'all') return { kind, startTime: 0, endTime: now };
  if (['7', '30', '90'].includes(kind)) return { kind, startTime: Math.max(0, now - Number(kind) * 86400000), endTime: now };
  if (kind !== 'custom' || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('Укажите начало и конец периода истории.');
  const start = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  const localDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || localDate(start) !== from || localDate(end) !== to || end < start || start.getTime() > now) throw new Error('Проверьте даты периода истории.');
  end.setDate(end.getDate() + 1);
  return { kind, from, to, startTime: start.getTime(), endTime: Math.min(now, end.getTime() - 0.001), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

export async function discoverHistory(search, period, options = {}) {
  const { pageSize = 1000, maxCalls = 256, maxDurationMs = 120000, callTimeoutMs = 15000, cancelled = () => false, onProgress = async () => {}, now = Date.now } = options;
  if (!(period.startTime >= 0 && period.endTime >= period.startTime)) throw new Error('Некорректный период истории');
  const started = now();
  const queue = [{ startTime: period.startTime, endTime: period.endTime }];
  const found = new Map(), limitations = new Set();
  let calls = 0, rawItems = 0, denseIntervals = 0;
  while (queue.length) {
    if (cancelled()) { limitations.add('cancelled'); break; }
    if (calls >= maxCalls) { limitations.add('request_limit'); break; }
    if (now() - started >= maxDurationMs) { limitations.add('time_limit'); break; }
    const interval = queue.pop();
    let values, timer;
    calls++;
    try {
      values = await Promise.race([
        Promise.resolve().then(() => search({ text: 'delta.yandex-team.ru', ...interval, maxResults: pageSize })),
        new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('History timeout')), Math.max(1, Math.min(callTimeoutMs, maxDurationMs - (now() - started)))); })
      ]);
      if (!Array.isArray(values)) throw new Error('Invalid history response');
    } catch {
      limitations.add('api_error');
      // The failed interval remains uncovered, rather than looking like an empty result.
      queue.push(interval); break;
    } finally { clearTimeout(timer); }
    rawItems += values.length;
    for (const value of values) {
      if (!isDelta(value.url)) continue;
      const url = new URL(value.url).href;
      const previous = found.get(url);
      if (!previous || (value.lastVisitTime || 0) > previous.lastVisitTime) {
        found.set(url, { url, title: String(value.title || ''), historyId: String(value.id || ''), lastVisitTime: Number(value.lastVisitTime) || 0, visitCount: Number(value.visitCount) || 0, typedCount: Number(value.typedCount) || 0 });
      }
    }
    if (values.length >= pageSize) {
      if (interval.endTime - interval.startTime <= 1) {
        limitations.add('dense_interval'); denseIntervals++;
      } else {
        const middle = interval.startTime + (interval.endTime - interval.startTime) / 2;
        // Overlapping inclusive boundaries prevent gaps. URL deduplication removes overlap.
        queue.push({ startTime: interval.startTime, endTime: middle }, { startTime: middle, endTime: interval.endTime });
      }
    }
    await onProgress({ calls, found: found.size, pendingIntervals: queue.length });
  }
  const links = [...found.values()].sort((a, b) => b.lastVisitTime - a.lastVisitTime || a.url.localeCompare(b.url));
  return {
    version: VERSION, source: 'browser_history', scannedAt: new Date(now()).toISOString(), period: structuredClone(period),
    coverage: limitations.size ? 'partial' : 'complete', coverageScope: 'available browser History API results in the requested period',
    limitations: [...limitations], calls, rawItems, denseIntervals, remainingIntervals: queue.length,
    deduplication: 'exact normalized URL; query and fragment preserved', links
  };
}

export function historyEntries(links, id = () => crypto.randomUUID()) {
  const seen = new Set();
  return links.filter(link => {
    if (!isDelta(link.url)) return false;
    const url = new URL(link.url).href;
    if (seen.has(url)) return false;
    seen.add(url); return true;
  }).map((link, index) => ({
    id: id(), source: 'history', tabId: null, windowId: null, index, groupId: -1,
    title: link.title, url: new URL(link.url).href, historyId: link.historyId,
    lastVisitTime: link.lastVisitTime, visitCount: link.visitCount, typedCount: link.typedCount,
    status: 'pending', attempts: 0, reviewed: false, temporaryTabs: []
  }));
}

export async function withHistoryTab(entry, tabs, task, onCreated = async () => {}) {
  let created;
  try { created = await tabs.create({ url: entry.url, active: false }); }
  catch { return { status: 'error', reason: 'tab_creation_failed', capture: null }; }
  if (!Number.isInteger(created?.id)) return { status: 'error', reason: 'tab_creation_failed', capture: null };
  // Ownership is held by this call, never inferred from an ID stored before a browser restart.
  const record = { tabId: created.id, openedAt: new Date().toISOString(), cleanup: 'pending' };
  entry.tabId = created.id; entry.windowId = created.windowId;
  (entry.temporaryTabs ||= []).push(record);
  try { await onCreated(); return await task(); }
  finally {
    try {
      let current;
      try { current = await tabs.get(created.id); } catch { record.cleanup = 'missing_or_unavailable'; }
      if (current) {
        if (current.active) record.cleanup = 'kept_active';
        else if (current.pinned) record.cleanup = 'kept_pinned';
        else if (!samePage(current.pendingUrl || current.url, entry.url)) record.cleanup = 'kept_navigated';
        else { await tabs.remove(created.id); record.cleanup = 'closed'; }
      }
    } catch { record.cleanup = 'cleanup_failed'; }
    record.cleanupAt = new Date().toISOString();
  }
}

export const historyLimitations = {
  cancelled: 'Поиск остановлен пользователем', request_limit: 'Достигнут лимит запросов: сузьте период',
  time_limit: 'Достигнут лимит времени поиска: сузьте период', api_error: 'История недоступна или запрос завершился ошибкой',
  dense_interval: 'Слишком много записей в одном интервале времени: часть могла не попасть в список'
};

export function historyLinkFiles(result) {
  return [
    { name: 'delta-links.txt', data: result.links.map(link => link.url).join('\n') + (result.links.length ? '\n' : '') },
    { name: 'history-links.json', data: JSON.stringify(result, null, 2) },
    { name: 'README.txt', data: 'Ссылки Delta из доступной истории браузера.\nПериод и полнота поиска: history-links.json.\nЭто список URL, а не сохранённое содержимое страниц. Для получения текста запустите бэкап выбранных ссылок.\nИстория не хранит прошлые версии документа; бэкап получает текущий текст.\n' }
  ];
}

// Only query the exact URLs of this inventory, before backup reads or reloads.
// This is the earliest available visit, not the creation time of the current tab.
export async function collectFirstVisits(entries, getVisits, options = {}) {
  const { concurrency = 3, callTimeoutMs = 15000, maxDurationMs = 120000,
    cancelled = () => false, onProgress = async () => {}, now = Date.now,
    unavailableReason = 'api_unavailable' } = options;
  const started = now();
  const results = new Map();
  const known = entry => ['found', 'not_found'].includes(entry.firstVisitLookup?.status);
  for (const entry of entries) if (known(entry)) results.set(entry.url, {
    firstVisitTime: entry.firstVisitTime, firstVisitLookup: structuredClone(entry.firstVisitLookup)
  });
  const urls = [...new Set(entries.filter(entry => !results.has(entry.url)).map(entry => entry.url))];
  let cursor = 0, completed = 0, calls = 0;
  await Promise.all(Array.from({ length: Math.min(urls.length, Math.max(1, Math.min(10, Math.floor(concurrency) || 1))) }, async () => {
    while (cursor < urls.length) {
      const url = urls[cursor++];
      let status, firstVisitTime, timer;
      if (!isDelta(url)) status = 'invalid_url';
      else if (cancelled()) status = 'cancelled';
      else if (now() - started >= maxDurationMs) status = 'time_limit';
      else if (typeof getVisits !== 'function') status = unavailableReason;
      else {
        calls++;
        try {
          const remaining = maxDurationMs - (now() - started);
          const deadlineStatus = remaining <= callTimeoutMs ? 'time_limit' : 'timeout';
          const visits = await Promise.race([
            Promise.resolve().then(() => getVisits({ url })),
            new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(deadlineStatus)), Math.max(1, Math.min(callTimeoutMs, remaining))); })
          ]);
          if (!Array.isArray(visits)) throw new Error('invalid_response');
          for (const visit of visits) {
            const time = visit?.visitTime;
            if (Number.isFinite(time) && time > 0 && time <= started && Number.isFinite(new Date(time).getTime()) && (!firstVisitTime || time < firstVisitTime)) firstVisitTime = time;
          }
          status = firstVisitTime ? 'found' : visits.length ? 'invalid_response' : 'not_found';
        } catch (error) {
          status = ['timeout', 'time_limit', 'invalid_response'].includes(error?.message) ? error.message : 'api_error';
        } finally { clearTimeout(timer); }
      }
      results.set(url, { firstVisitTime, firstVisitLookup: { status, checkedAt: new Date(now()).toISOString(), source: 'available_browser_history' } });
      completed++;
      await onProgress({ completed, total: urls.length });
    }
  }));
  const enriched = entries.map(entry => ({ ...entry, ...results.get(entry.url) }));
  return {
    entries: enriched, checkedAt: new Date(now()).toISOString(), calls,
    coverage: enriched.every(known) ? 'complete' : 'partial',
    scope: 'earliest available visit for exact open-tab URLs; not tab creation time or guaranteed first-ever visit'
  };
}

export const firstVisitLimitations = {
  not_found: 'В доступной истории нет визитов этой ссылки', invalid_response: 'История не вернула корректное время визита',
  api_error: 'Не удалось прочитать визиты этой ссылки', api_unavailable: 'Браузер не предоставляет API визитов',
  permission_denied: 'Нет разрешения на чтение истории', timeout: 'Истёк лимит запроса визитов',
  time_limit: 'Истёк общий лимит поиска дат', cancelled: 'Поиск даты приостановлен', invalid_url: 'Адрес не относится к Delta'
};
