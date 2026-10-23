// Sauvegarde locale (IndexedDB) du dernier MP3 / image : rien n'est perdu si l'onglet recharge
// (ex. Safari iOS qui tue l'onglet faute de mémoire). Tout reste sur l'appareil.

const DB = 'suno2x';
const STORE = 'files';

export interface StoredFile {
  blob: Blob;
  name: string;
  fromCover?: boolean;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => {
      db.close();
      resolve(req.result);
    };
    t.onerror = t.onabort = () => {
      db.close();
      reject(t.error);
    };
  });
}

export async function saveFile(key: 'audio' | 'image', f: StoredFile | null): Promise<void> {
  try {
    if (f) {
      // copie en Blob simple (certains navigateurs refusent de stocker un File)
      const blob = new Blob([await f.blob.arrayBuffer()], { type: f.blob.type });
      await tx('readwrite', (s) => s.put({ ...f, blob }, key));
    } else await tx('readwrite', (s) => s.delete(key));
  } catch (e) {
    console.warn('Sauvegarde locale impossible', e);
  }
}

export async function loadFile(key: 'audio' | 'image'): Promise<StoredFile | null> {
  try {
    return ((await tx('readonly', (s) => s.get(key))) as StoredFile | undefined) ?? null;
  } catch {
    return null;
  }
}
