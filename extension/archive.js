import { VERSION, capturePath, safeName, statusLabel, reasons } from './core.js';

function cleanTextFile(text, fallbackTitle, usedNames) {
  const title = String(text).split(/\r\n|\n|\r/).find(line => line.trim())?.trim() || fallbackTitle || 'Без названия';
  // Match document titles without adding metadata or changing the saved source.
  const base = safeName(title);
  let name = `${base}.md`, number = 1;
  const key = value => value.normalize('NFC').toLowerCase();
  while (usedNames.has(key(name))) name = `${base} (${++number}).md`;
  usedNames.add(key(name));
  return { title, name: `Чистые/${name}`, data: text };
}

export async function archiveFiles(run, readCapture) {
  const files = [];
  const usedCleanNames = new Set();
  const report = structuredClone(run);
  const lines = [run.source === 'history' ? 'Бэкап текущих страниц Delta по ссылкам из истории' : 'Бэкап открытых вкладок Delta', `Создан: ${run.createdAt}`, `Версия: ${VERSION}`, '', 'Статус «сохранено» означает, что текст прочитан после готовности страницы и записан в локальную базу. Ограничения извлечения отражаются в записи страницы.', 'Новые бэкапы читаются без прокрутки: из доступной модели редактора или текста страницы. В старых бэкапах snapshots/ могут содержать фрагменты обхода прокруткой. Ограничения чтения указаны в capture.json.', 'partial.txt и partial:true означают, что процедура чтения/ожидания не завершилась. Это не доказательство обрезанного текста; завершённым проходом такой результат не считается.', run.source === 'history' ? 'Список относится к выбранным URL из доступной истории. Это текущий текст, а не версия на дату визита. Исторические группы неизвестны.' : 'Список относится к вкладкам, открытым на момент начала, а не ко всем документам сервиса.', run.source === 'history' ? 'Полные одинаковые URL из истории объединены; query и fragment сохранены.' : 'Повторяющиеся URL не удаляются: у каждой вкладки собственная запись.', 'Оригинальные URL и содержимое находятся только в локальном архиве.', ''];
  if (run.source === 'history') {
    files.push({ name: 'delta-links.txt', data: run.entries.map(entry => entry.url).join('\n') + '\n' });
    files.push({ name: 'history-links.json', data: JSON.stringify({ ...run.historySearch, links: run.entries.map(entry => ({ url: entry.url, title: entry.title, historyId: entry.historyId, lastVisitTime: entry.lastVisitTime, visitCount: entry.visitCount })) }, null, 2) });
  }
  for (let index = 0; index < run.entries.length; index++) {
    const entry = run.entries[index];
    const folder = capturePath(entry, index);
    let capture = entry.captureId ? await readCapture(entry.captureId) : undefined;
    if (entry.captureId && !capture) throw new Error('Не найден локальный снимок вкладки. Архив не создан, чтобы не выдать неполный результат за полный.');
    report.entries[index].folder = folder;
    report.entries[index].statusLabel = statusLabel(entry);
    if (capture) {
      const successful = entry.status === 'captured' && !capture.partial;
      const textFile = successful ? 'text.txt' : 'partial.txt';
      files.push({ name: `${folder}/${textFile}`, data: capture.text });
      files.push({ name: `${folder}/capture.json`, data: JSON.stringify(capture, null, 2) });
      for (let i = 0; i < capture.samples.length; i++) {
        files.push({ name: `${folder}/snapshots/${String(i + 1).padStart(3, '0')}.txt`, data: capture.samples[i].text });
      }
      report.entries[index].textFile = `${folder}/${textFile}`;
      const clean = cleanTextFile(capture.text, entry.title, usedCleanNames);
      files.push({ name: clean.name, data: clean.data });
      report.entries[index].cleanFile = clean.name;
      report.entries[index].cleanTitle = clean.title;
    }
    const oneLine = value => String(value || '').replace(/[\r\n\t]/g, ' ');
    const sourceLine = entry.source === 'history' ? 'Из истории браузера; исходное окно и группа неизвестны' : `Окно ${entry.windowId}; группа: ${oneLine(entry.groupTitle || (entry.groupId < 0 ? 'Без группы' : entry.groupId))}`;
    lines.push(`${index + 1}. ${oneLine(entry.title)}`, `   ${oneLine(entry.url)}`, `   ${sourceLine}`, `   ${statusLabel(entry)}${entry.reason ? '; ' + (reasons[entry.reason] || entry.reason) : ''}`, `   ${folder}`, '');
  }
  report.summary = {
    found: run.entries.length, captured: run.entries.filter(e => e.status === 'captured').length,
    failed: run.entries.filter(e => ['timeout', 'error', 'closed', 'navigated'].includes(e.status)).length,
    pending: run.entries.filter(e => ['pending', 'waiting'].includes(e.status)).length
  };
  files.unshift({ name: 'index.txt', data: lines.join('\n') }, { name: 'report.json', data: JSON.stringify(report, null, 2) });
  return files;
}
