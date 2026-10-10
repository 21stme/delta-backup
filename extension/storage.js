let database;
export function openDB() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open('delta-local-backup', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('runs', { keyPath: 'id' });
      request.result.createObjectStore('captures', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}
export async function saveRun(run, capture) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(capture ? ['runs', 'captures'] : ['runs'], 'readwrite');
    transaction.objectStore('runs').put(structuredClone(run));
    if (capture) transaction.objectStore('captures').put(capture);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('Запись прервана'));
  });
}
export async function readStore(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function listRuns() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction('runs').objectStore('runs').getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    request.onerror = () => reject(request.error);
  });
}
