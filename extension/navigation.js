import { samePage } from './core.js';

// Called only by the user's navigation button. Capture never activates tabs.
export async function goToOriginalTab(entry, tabs, windows) {
  if (entry.source === 'history') throw new Error('У страницы из истории нет исходной открытой вкладки.');
  let tab;
  try { tab = await tabs.get(entry.tabId); }
  catch { throw new Error('Исходная вкладка закрыта или недоступна.'); }
  if (!tab || !samePage(tab.pendingUrl || tab.url, entry.url)) throw new Error('Исходная вкладка теперь показывает другой адрес.');
  await tabs.update(tab.id, { active: true });
  await windows.update(tab.windowId, { focused: true });
}
