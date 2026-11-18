// Node tests for storage.js. Round-trip save/list/get/delete through a
// minimal fake IndexedDB that implements exactly the interfaces
// storage.js uses (open, createObjectStore, put/get/getAll/delete).
// Run: node test/storage.test.mjs
import assert from "node:assert";
import {
  formatTitle, formatDuration, openDb, saveRecording,
  listRecordings, getRecording, deleteRecording, estimateUsage,
} from "../storage.js";

assert.equal(formatTitle(new Date(2026, 10, 18, 16, 43)), "2026-11-18 16:43");
assert.equal(formatDuration(0), "0:00");
assert.equal(formatDuration(65000), "1:05");
assert.equal(formatDuration(125000), "2:05");
assert.equal(formatDuration(3599000), "59:59");

// --- Minimal fake IndexedDB -------------------------------------------------
class FakeRequest {
  constructor() { this.result = undefined; this.error = undefined; this.onsuccess = null; this.onerror = null; }
  _succeed(result) { this.result = result; queueMicrotask(() => { if (this.onsuccess) this.onsuccess(); }); }
  _fail(error) { this.error = error; queueMicrotask(() => { if (this.onerror) this.onerror(); }); }
}

function makeFakeDb() {
  const stores = new Map();
  const created = new Set();
  return {
    objectStoreNames: { contains: (name) => created.has(name) },
    createObjectStore(name, { keyPath, autoIncrement }) {
      created.add(name);
      const data = new Map();
      let seq = 0;
      const store = {
        createIndex: () => {},
        put(value) {
          const req = new FakeRequest();
          const record = { ...value };
          if (record[keyPath] == null && autoIncrement) record[keyPath] = ++seq;
          data.set(record[keyPath], record);
          req._succeed(record[keyPath]);
          return req;
        },
        get(key) { const req = new FakeRequest(); req._succeed(data.get(key)); return req; },
        getAll() { const req = new FakeRequest(); req._succeed([...data.values()]); return req; },
        delete(key) { const req = new FakeRequest(); data.delete(key); req._succeed(undefined); return req; },
        index() { return { getAll: () => store.getAll() }; },
      };
      stores.set(name, store);
      return store;
    },
    transaction(_names, _mode) {
      return { objectStore: (name) => stores.get(name) };
    },
  };
}

function fakeIndexedDB() {
  const dbs = new Map();
  return {
    open(name, _version) {
      const req = new FakeRequest();
      queueMicrotask(() => {
        let db = dbs.get(name);
        if (!db) {
          db = makeFakeDb();
          dbs.set(name, db);
          req.result = db;
          if (req.onupgradeneeded) req.onupgradeneeded();
        }
        req.result = db;
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
}

const idb = fakeIndexedDB();

const entry = {
  title: "2026-11-18 16:43",
  durationMs: 65000,
  kind: "camera",
  mediaBlob: new Blob(["fake-video"], { type: "video/webm" }),
  segments: [{ transcript: "Hello world.", isFinal: true, fromTimestampMs: 0, toTimestampMs: 1500 }],
  text: "Hello world.",
};

// Save assigns ids; list is newest first; get/delete round-trip.
const id1 = await saveRecording({ ...entry, createdAt: 1000 }, idb);
const id2 = await saveRecording({ ...entry, title: "second", createdAt: 2000 }, idb);
assert.equal(typeof id1, "number");
assert.notEqual(id1, id2);

const listed = await listRecordings(idb);
assert.equal(listed.length, 2);
assert.equal(listed[0].title, "second"); // newest first
assert.equal(listed[1].title, "2026-11-18 16:43");

const got = await getRecording(id1, idb);
assert.equal(got.text, "Hello world.");
assert.equal(got.kind, "camera");
assert.equal(got.mediaBlob.size, 10);
assert.equal(got.segments[0].transcript, "Hello world.");

await deleteRecording(id1, idb);
assert.equal((await listRecordings(idb)).length, 1);
assert.equal(await getRecording(id1, idb), undefined);

// createdAt defaults to now when omitted.
const id3 = await saveRecording({ ...entry, createdAt: undefined }, idb);
const got3 = await getRecording(id3, idb);
assert.ok(typeof got3.createdAt === "number" && got3.createdAt > 0);

// estimateUsage: null without the API, numbers with a stub.
assert.equal(await estimateUsage(null), null);
assert.deepEqual(
  await estimateUsage({ estimate: async () => ({ usage: 5 * 1024 * 1024, quota: 100 * 1024 * 1024 }) }),
  { usedMB: 5, quotaMB: 100 },
);

// openDb works and is idempotent across calls.
await openDb(idb);
await openDb(idb);

console.log("storage tests passed");
