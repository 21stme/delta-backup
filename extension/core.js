export const ORIGIN = 'https://delta.yandex-team.ru';
export const VERSION = '1.4.1';
export function isDelta(url) {
  try { return new URL(url).origin === ORIGIN; } catch { return false; }
}
export function samePage(a, b) {
  try {
    const x = new URL(a), y = new URL(b);
    // Keep query and hash: Delta may route different documents through either.
    return x.href === y.href;
  } catch { return false; }
}
export function safeName(value) {
  return String(value || 'Без названия').normalize('NFC').replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 90) || 'Без названия';
}
export function hasFullAceSource(snapshot, editors = []) {
  return snapshot.frames.length === 1 && snapshot.frames[0].aceSourceOnly && editors.length === 1 && editors[0].kind === 'Ace' && editors[0].name === snapshot.frames[0].aceEditorId && typeof editors[0].text === 'string';
}
export function textOf(snapshot, editors = []) {
  if (hasFullAceSource(snapshot, editors)) return editors[0].text;
  const chunks = snapshot.frames.map(frame => frame.frame === 'main' ? frame.text : `[${frame.frame}]\n${frame.text}`).filter(Boolean);
  for (const editor of editors) {
    if (editor.text && !chunks.some(chunk => chunk.includes(editor.text))) chunks.push(`[Полный текст редактора ${editor.kind}]\n${editor.text}`);
  }
  return chunks.join('\n\n');
}
export function fingerprint(value) {
  // Used for change detection, not security or archive integrity.
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return `${value.length}:${hash >>> 0}`;
}
export function detectGate(snapshot, text) {
  if (snapshot.error) return { fatal: snapshot.error };
  if (snapshot.warnings.includes('authentication_required')) return { fatal: 'authentication_required' };
  if (snapshot.warnings.includes('page_error')) return { fatal: 'page_error' };
  const meaningful = text.trim() && !/^(?:загрузка[.…\s]*|loading[.…\s]*|подождите[.…\s]*)$/i.test(text.trim());
  const waitingReason = snapshot.readyState !== 'complete' || snapshot.busy ? 'deadline_page_loading' : !meaningful ? 'deadline_empty_text' : undefined;
  return { eligible: !waitingReason, waitingReason };
}
export function statusLabel(entry) {
  return ({ pending: 'В очереди', waiting: 'Ожидаю текст', captured: 'Сохранено', timeout: entry.characters > 0 ? 'Текст сохранён · ожидание не завершено' : 'Истёк лимит ожидания', error: 'Ошибка', closed: 'Вкладка закрыта', navigated: 'Адрес вкладки изменился' })[entry.status] || entry.status;
}
export function capturePath(entry, index) {
  if (entry.source === 'history') return `История/${String(index + 1).padStart(4, '0')}__${safeName(entry.title)}__${safeName(entry.id)}`;
  const group = entry.groupId < 0 ? 'Без группы' : `${safeName(entry.groupTitle || 'Группа')}__${entry.groupId}`;
  return `Окно-${entry.windowId}/${group}/${String(index + 1).padStart(4, '0')}__${safeName(entry.title)}__tab-${entry.tabId}`;
}
export const reasons = {
  wrong_origin: 'Страница перенаправила на другой домен',
  closed: 'Исходной вкладки больше нет в браузере',
  navigated: 'URL отличается от адреса в начале бэкапа',
  invalid_selector: 'Некорректный CSS-селектор в настройках',
  collector_error: 'Не удалось прочитать страницу',
  authentication_required: 'На странице требуется вход',
  page_error: 'На странице обнаружено сообщение об ошибке',
  deadline: 'Истёк лимит ожидания. Подробная причина в этой записи не сохранена; можно повторить чтение',
  deadline_browser_loading: 'Истёк лимит: браузер всё ещё сообщает о загрузке вкладки',
  deadline_page_loading: 'Истёк лимит: страница всё ещё показывает загрузку или не появился заданный признак готовности',
  deadline_empty_text: 'Истёк лимит: содержательный текст не появился',
  deadline_unstable_text: 'Истёк лимит: текст не оставался неизменным весь заданный период',
  // Legacy codes remain readable in backups from versions that used scrolling.
  deadline_scrolling: 'Истёк лимит: обход прокруткой не завершён. Доступные снимки сохранены; полнота не подтверждена',
  deadline_reading: 'Истёк лимит: не удалось получить очередной снимок страницы',
  scroll_limit: 'Достигнут лимит прокрутки; текст мог быть подгружен не полностью',
  injection_failed: 'Браузер не позволил прочитать вкладку',
  browser_unresponsive: 'Браузер не ответил; наличие вкладки не удалось проверить',
  tab_creation_failed: 'Не удалось открыть временную вкладку',
  reload_limit: 'Страница просит перезагрузку; достигнут заданный предел перезагрузок',
  editor_or_virtualized_content: 'Обнаружен редактор или виртуализированный список (сведения о способе отображения)',
  virtualized_content_unverified: 'Полнота виртуализированного документа не подтверждена; сохранён доступный текст без обхода скрытых строк',
  editor_probe_unavailable: 'Не удалось прочитать модели редакторов; сохранён только текст страницы',
  ace_model_unavailable: 'Полную модель Ace прочитать не удалось; сохранены только отрисованные строки, документ может быть неполным',
  unreadable_frame: 'Есть iframe, который не удалось прочитать',
  collapsed_content: 'Есть свёрнутые блоки; они автоматически не открывались',
  too_many_scroll_containers: 'Более 24 областей прокрутки; часть не обойдена',
  scroll_container_replaced: 'Во время загрузки заменена область прокрутки',
  frame_depth_limit: 'Вложенность iframe превышает поддерживаемую',
  readiness_is_heuristic: 'Готовность определена по тексту и индикаторам; полнота не подтверждена',
  manual_review: 'Полнота отмечена пользователем вручную'
};
