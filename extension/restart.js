import { VERSION } from './core.js';
import { historyEntries } from './browser-history.js';

export async function restartBackup(previous, settings, inventory) {
  if (!previous) throw new Error('Выберите бэкап, чтобы начать его заново.');
  let fresh;
  if (previous.source !== 'history') {
    fresh = await inventory(structuredClone(settings));
  } else {
    const links = previous.entries.map(entry => ({
      historyId: entry.historyId, title: entry.title, url: entry.url,
      lastVisitTime: entry.lastVisitTime, visitCount: entry.visitCount, typedCount: entry.typedCount
    }));
    const entries = historyEntries(links);
    if (!entries.length) throw new Error('В выбранном бэкапе нет подходящих ссылок Delta.');
    const createdAt = new Date().toISOString();
    fresh = {
      id: `${createdAt.replace(/[:.]/g, '-')}-${crypto.randomUUID()}`,
      createdAt, updatedAt: createdAt, version: VERSION, source: 'history', state: 'paused',
      settings: structuredClone(settings), entries, groupCoverage: 'not_in_browser_history',
      scope: 'current content of selected URLs from available browser history',
      historySearch: previous.historySearch ? { ...structuredClone(previous.historySearch), selected: entries.length } : undefined
    };
  }
  fresh.restartedFrom = previous.id;
  return fresh;
}
