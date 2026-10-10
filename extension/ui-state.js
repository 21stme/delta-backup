export function entryState(entry) {
  if (entry.status === 'captured') return 'saved';
  if (entry.status === 'waiting') return 'reading';
  if (entry.status === 'pending') return 'pending';
  return 'problems';
}

export function pageCounts(entries = []) {
  const counts = { total: entries.length, saved: 0, reading: 0, pending: 0, problems: 0, processed: 0, retryable: 0 };
  for (const entry of entries) {
    counts[entryState(entry)]++;
    if (['timeout', 'error'].includes(entry.status)) counts.retryable++;
  }
  counts.processed = counts.saved + counts.problems;
  return counts;
}

export function filterEntries(entries, filter = 'all', query = '') {
  const normalized = value => String(value || '').normalize('NFC').toLocaleLowerCase('ru-RU');
  const search = normalized(query.trim());
  return entries.filter(entry => (filter === 'all' || entryState(entry) === filter) && normalized(entry.title || 'Без названия').includes(search));
}
