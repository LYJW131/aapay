const DB_NAME = 'aapay-demo';
const STORE = 'databases';

export type Saved = Map<string, Uint8Array>;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export async function loadSaved(): Promise<Saved> {
  const saved: Saved = new Map();
  try {
    const db = await open();
    const tx = db.transaction(STORE, 'readonly');
    const cursor = tx.objectStore(STORE).openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return;
      saved.set(String(c.key), c.value as Uint8Array);
      c.continue();
    };
    await done(tx);
    db.close();
  } catch {
  }
  return saved;
}

export async function writeSaved(saved: Saved) {
  try {
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.clear();
    for (const [key, bytes] of saved) store.put(bytes, key);
    await done(tx);
    db.close();
  } catch {
  }
}

export async function clearSaved() {
  await writeSaved(new Map());
}
