// All IndexedDB access for Stash v2.
// Every error path logs to console — nothing fails silently.

const DB_NAME = 'stash-v2';
const DB_VERSION = 1;

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onerror = () => {
      console.error('[Stash DB] Failed to open:', req.error);
      _dbPromise = null;
      reject(req.error);
    };

    req.onsuccess = () => {
      const db = req.result;
      db.onerror = (e) => console.error('[Stash DB] Unhandled error:', e.target.error);
      db.onversionchange = () => {
        db.close();
        _dbPromise = null;
        console.warn('[Stash DB] Version changed — connection closed');
      };
      resolve(db);
    };

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      if (!db.objectStoreNames.contains('folders')) {
        const s = db.createObjectStore('folders', { keyPath: 'id', autoIncrement: true });
        s.createIndex('by-type', 'type');
        s.createIndex('by-parent', 'parentId');
        s.createIndex('by-name', 'name');
      }

      if (!db.objectStoreNames.contains('lists')) {
        const s = db.createObjectStore('lists', { keyPath: 'id', autoIncrement: true });
        s.createIndex('by-folder', 'folderId');
      }

      if (!db.objectStoreNames.contains('highlights')) {
        const s = db.createObjectStore('highlights', { keyPath: 'id', autoIncrement: true });
        s.createIndex('by-list', 'listId');
        s.createIndex('by-folder', 'folderId');
        s.createIndex('by-saved-at', 'savedAt');
      }

      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
  });

  return _dbPromise;
}

// Wraps an IDBRequest in a promise, logging on error.
function wrap(idbReq, label) {
  return new Promise((resolve, reject) => {
    idbReq.onsuccess = () => resolve(idbReq.result);
    idbReq.onerror = () => {
      console.error(`[Stash DB] ${label ?? 'request'} error:`, idbReq.error);
      reject(idbReq.error);
    };
  });
}

function readTx(db, store) {
  const t = db.transaction(store, 'readonly');
  t.onerror = () => console.error('[Stash DB] read tx error:', t.error);
  return t.objectStore(store);
}

function writeTx(db, store) {
  const t = db.transaction(store, 'readwrite');
  t.onerror = () => console.error('[Stash DB] write tx error:', t.error);
  return t.objectStore(store);
}

async function getAllByIndex(storeName, indexName, query) {
  const db = await openDB();
  const store = readTx(db, storeName);
  return wrap(store.index(indexName).getAll(query), `${storeName}.${indexName}.getAll`);
}

// ─── folders ────────────────────────────────────────────────────────────────

export async function getFolder(id) {
  const db = await openDB();
  return wrap(readTx(db, 'folders').get(id), 'getFolder');
}

export async function getAllFolders() {
  const db = await openDB();
  return wrap(readTx(db, 'folders').getAll(), 'getAllFolders');
}

export async function getFoldersByType(type) {
  return getAllByIndex('folders', 'by-type', IDBKeyRange.only(type));
}

export async function getFoldersByParent(parentId) {
  return getAllByIndex('folders', 'by-parent', IDBKeyRange.only(parentId));
}

export async function getFolderByName(name) {
  const results = await getAllByIndex('folders', 'by-name', IDBKeyRange.only(name));
  return results[0] ?? null;
}

export async function createFolder(data) {
  const db = await openDB();
  return wrap(
    writeTx(db, 'folders').add({ parentId: null, colour: null, ...data, createdAt: Date.now() }),
    'createFolder'
  );
}

export async function updateFolder(id, patch) {
  const db = await openDB();
  const store = writeTx(db, 'folders');
  const existing = await wrap(store.get(id), 'updateFolder.get');
  if (!existing) {
    console.error('[Stash DB] updateFolder: not found:', id);
    throw new Error(`Folder ${id} not found`);
  }
  return wrap(store.put({ ...existing, ...patch, id }), 'updateFolder.put');
}

export async function deleteFolder(id) {
  const db = await openDB();
  return wrap(writeTx(db, 'folders').delete(id), 'deleteFolder');
}

// ─── lists ──────────────────────────────────────────────────────────────────

export async function getList(id) {
  const db = await openDB();
  return wrap(readTx(db, 'lists').get(id), 'getList');
}

export async function getListsByFolder(folderId) {
  return getAllByIndex('lists', 'by-folder', IDBKeyRange.only(folderId));
}

export async function createList(data) {
  const db = await openDB();
  return wrap(
    writeTx(db, 'lists').add({ isArchived: false, isSeeded: false, displayOrder: 0, ...data }),
    'createList'
  );
}

export async function updateList(id, patch) {
  const db = await openDB();
  const store = writeTx(db, 'lists');
  const existing = await wrap(store.get(id), 'updateList.get');
  if (!existing) {
    console.error('[Stash DB] updateList: not found:', id);
    throw new Error(`List ${id} not found`);
  }
  return wrap(store.put({ ...existing, ...patch, id }), 'updateList.put');
}

export async function deleteList(id) {
  const db = await openDB();
  return wrap(writeTx(db, 'lists').delete(id), 'deleteList');
}

// ─── highlights ─────────────────────────────────────────────────────────────

export async function getHighlight(id) {
  const db = await openDB();
  return wrap(readTx(db, 'highlights').get(id), 'getHighlight');
}

export async function getHighlightsByList(listId) {
  return getAllByIndex('highlights', 'by-list', IDBKeyRange.only(listId));
}

export async function getHighlightsByFolder(folderId) {
  return getAllByIndex('highlights', 'by-folder', IDBKeyRange.only(folderId));
}

export async function createHighlight(data) {
  const db = await openDB();
  // originalPosition is the count of existing highlights in the list at save time.
  // It is set once here and stripped from all future updates.
  const existing = await getHighlightsByList(data.listId);
  const originalPosition = existing.length;
  return wrap(
    writeTx(db, 'highlights').add({
      tags: [],
      notes: '',
      checkboxChecked: false,
      displayOrder: originalPosition,
      conversationUrl: null,
      ...data,
      originalPosition,
      savedAt: Date.now(),
    }),
    'createHighlight'
  );
}

export async function updateHighlight(id, patch) {
  const db = await openDB();
  const store = writeTx(db, 'highlights');
  const existing = await wrap(store.get(id), 'updateHighlight.get');
  if (!existing) {
    console.error('[Stash DB] updateHighlight: not found:', id);
    throw new Error(`Highlight ${id} not found`);
  }
  // originalPosition and conversationUrl are immutable — always discard from patches.
  const { originalPosition: _ignored, conversationUrl: _ignUrl, ...safe } = patch;
  return wrap(store.put({ ...existing, ...safe, id }), 'updateHighlight.put');
}

export async function deleteHighlight(id) {
  const db = await openDB();
  return wrap(writeTx(db, 'highlights').delete(id), 'deleteHighlight');
}

export async function deleteHighlightsByList(listId) {
  const items = await getHighlightsByList(listId);
  const db = await openDB();
  const store = writeTx(db, 'highlights');
  return Promise.all(items.map((h) => wrap(store.delete(h.id), 'deleteHighlightsByList')));
}

// ─── cascade deletes ─────────────────────────────────────────────────────────
// Phase-1: read all IDs. Phase-2: delete atomically in one transaction.
// This avoids the IDB auto-commit problem with async gaps inside a transaction.

async function collectFolderIds(folderId) {
  const lists = await getListsByFolder(folderId);
  const listIds = lists.map((l) => l.id);
  const hArrays = await Promise.all(listIds.map((lid) => getHighlightsByList(lid)));
  const highlightIds = hArrays.flat().map((h) => h.id);
  return { listIds, highlightIds };
}

function atomicDelete(db, { folderIds = [], listIds = [], highlightIds = [] }) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(['folders', 'lists', 'highlights'], 'readwrite');
    t.onerror = () => {
      console.error('[Stash DB] atomicDelete error:', t.error);
      reject(t.error);
    };
    t.oncomplete = () => resolve();

    const fs = t.objectStore('folders');
    const ls = t.objectStore('lists');
    const hs = t.objectStore('highlights');

    folderIds.forEach((id) => fs.delete(id));
    listIds.forEach((id) => ls.delete(id));
    highlightIds.forEach((id) => hs.delete(id));
  });
}

// §3.2 conversation folder delete: atomic cascade.
export async function deleteConversationFolderCascade(folderId) {
  const db = await openDB();
  const { listIds, highlightIds } = await collectFolderIds(folderId);
  await atomicDelete(db, { folderIds: [folderId], listIds, highlightIds });
}

// §3.2 project folder delete: cascade all child conversation folders.
export async function deleteProjectFolderCascade(projectFolderId) {
  const db = await openDB();
  const convFolders = await getFoldersByParent(projectFolderId);
  const convFolderIds = convFolders.map((f) => f.id);

  const collected = await Promise.all(convFolderIds.map(collectFolderIds));
  const listIds = collected.flatMap((c) => c.listIds);
  const highlightIds = collected.flatMap((c) => c.highlightIds);

  await atomicDelete(db, {
    folderIds: [projectFolderId, ...convFolderIds],
    listIds,
    highlightIds,
  });
}

// §3.2 manual folder delete: remove folder + its lists; move conversation folders to General.
// Returns the list of conversation folder IDs that were moved (caller re-parents them).
export async function deleteManualFolderCascade(folderId) {
  const db = await openDB();
  const lists = await getListsByFolder(folderId);
  const listIds = lists.map((l) => l.id);
  const hArrays = await Promise.all(listIds.map((lid) => getHighlightsByList(lid)));
  const highlightIds = hArrays.flat().map((h) => h.id);

  const convFolders = await getFoldersByParent(folderId);

  await atomicDelete(db, { folderIds: [folderId], listIds, highlightIds });
  return convFolders.map((f) => f.id);
}

// ─── meta ────────────────────────────────────────────────────────────────────

export async function getMeta(key) {
  const db = await openDB();
  const record = await wrap(readTx(db, 'meta').get(key), `getMeta(${key})`);
  return record?.value ?? null;
}

export async function setMeta(key, value) {
  const db = await openDB();
  return wrap(writeTx(db, 'meta').put({ key, value }), `setMeta(${key})`);
}
