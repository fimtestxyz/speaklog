// IndexedDB wrapper for saved recordings. DOM-free apart from the
// IndexedDB + navigator.storage globals, which are injectable so the
// layer is unit-testable with a fake (see test/storage.test.mjs).
//
// Record shape:
//   { id, title, createdAt, durationMs, kind: "camera" | "file",
//     mediaBlob, segments: [{ transcript, isFinal, fromTimestampMs,
//     toTimestampMs }], text, fileName? }
// kind "camera" entries carry a video Blob; kind "file" entries carry
// the uploaded audio/video file's Blob for playback.

export const DB_NAME = "speaklog";
export const DB_VERSION = 1;
export const STORE_NAME = "recordings";

/** "2026-11-18 16:43" in local time — the default recording title. */
export function formatTitle(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 65000 -> "1:05". */
export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

export function openDb(idb = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    const req = idb.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Could not open library database"));
  });
}

function storeTx(db, mode) {
  return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
}

/** Save a recording; returns its id. */
export async function saveRecording(entry, idb = globalThis.indexedDB) {
  const db = await openDb(idb);
  const record = { ...entry, createdAt: entry.createdAt ?? Date.now() };
  return promisify(storeTx(db, "readwrite").put(record));
}

/** All recordings, newest first. */
export async function listRecordings(idb = globalThis.indexedDB) {
  const db = await openDb(idb);
  const all = await promisify(storeTx(db, "readonly").getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getRecording(id, idb = globalThis.indexedDB) {
  const db = await openDb(idb);
  return promisify(storeTx(db, "readonly").get(id));
}

export async function deleteRecording(id, idb = globalThis.indexedDB) {
  const db = await openDb(idb);
  return promisify(storeTx(db, "readwrite").delete(id));
}

/**
 * Browser storage use, or null when the API is unavailable.
 * Returns { usedMB, quotaMB }.
 */
export async function estimateUsage(storage) {
  const api = storage || (typeof navigator !== "undefined" ? navigator.storage : null);
  if (!api || typeof api.estimate !== "function") return null;
  const { usage = 0, quota = 0 } = await api.estimate();
  return { usedMB: usage / (1024 * 1024), quotaMB: quota / (1024 * 1024) };
}
