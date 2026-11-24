// Takes live in IndexedDB, in this browser only. "meta" holds one small record per take
// (indexed by scope = speaker/language); "audio" holds its 16-bit PCM under the same key.

const NAME = "voicedataset";
let opening;

function open() {
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const r = indexedDB.open(NAME, 1);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore("meta", { keyPath: "key" }).createIndex("scope", "scope");
        db.createObjectStore("audio");
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return opening;
}

const settle = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

const result = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

export async function putTake(meta, pcm) {
  const db = await open();
  const tx = db.transaction(["meta", "audio"], "readwrite");
  tx.objectStore("meta").put(meta);
  tx.objectStore("audio").put(pcm, meta.key);
  return settle(tx);
}

export async function takesIn(scope) {
  const db = await open();
  return result(db.transaction("meta").objectStore("meta").index("scope").getAll(scope));
}

export async function audio(key) {
  const db = await open();
  return result(db.transaction("audio").objectStore("audio").get(key));
}

export async function removeScope(scope) {
  const db = await open();
  const metas = await takesIn(scope);
  const tx = db.transaction(["meta", "audio"], "readwrite");
  for (const m of metas) {
    tx.objectStore("meta").delete(m.key);
    tx.objectStore("audio").delete(m.key);
  }
  return settle(tx);
}
