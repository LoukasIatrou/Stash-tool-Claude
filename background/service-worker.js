import {
  getAllFolders,
  getFoldersByParent,
  getListsByFolder,
  updateList,
  getMeta,
  getHighlightsByList,
  createHighlight,
  updateHighlight,
  deleteHighlight,
  nextHighlightOrder,
  reorderLists,
  reorderHighlights,
} from '../db/db.js';
import {
  ensureConversationFolder,
  createManualFolder,
  renameFolder,
  deleteFolderById,
} from '../folders/folders.js';
import {
  createCustomList,
  renameList,
  archiveList,
  deleteListWithHighlights,
} from '../lists/lists.js';
import { runMigrationIfNeeded } from '../migration/migration.js';

// All writes funnel through this one worker, so a promise chain is enough to make
// read-then-create flows (find-or-create folder, unique names, migration) atomic.
let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

serial(runMigrationIfNeeded).catch((err) => console.error('[Stash SW] Migration failed:', err));

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'stash-keepalive') {
    port.onDisconnect.addListener(() => console.log('[Stash SW] Keep-alive port disconnected'));
  }
});

chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR' }, () => {
    if (chrome.runtime.lastError) {
      console.error('[Stash SW] TOGGLE_SIDEBAR send failed:', chrome.runtime.lastError.message);
    }
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(sendResponse).catch((err) => {
    console.error(`[Stash SW] Handler error (${msg?.type}):`, err);
    sendResponse({ error: err.message ?? String(err) });
  });
  return true;
});

async function handle(m) {
  switch (m.type) {
    case 'GET_FOLDERS':
      return { folders: await getAllFolders(), generalId: await getMeta('generalFolderId') };
    case 'GET_CHILDREN':
      return { children: await getFoldersByParent(m.parentId) };
    case 'ENSURE_CONVERSATION_FOLDER':
      return serial(() =>
        ensureConversationFolder(m.conversationTitle, m.projectName ?? null, m.conversationId ?? null)
      );
    case 'CREATE_MANUAL_FOLDER':
      return { id: await serial(() => createManualFolder(m.name, m.colour)) };
    case 'RENAME_FOLDER':
      await renameFolder(m.id, m.name);
      return { ok: true };
    case 'DELETE_FOLDER':
      await serial(() => deleteFolderById(m.id));
      return { ok: true };

    case 'GET_LISTS':
      return { lists: await getListsByFolder(m.folderId) };
    case 'CREATE_LIST':
      return {
        id: await createCustomList({
          folderId: m.folderId,
          name: m.name,
          colour: m.colour,
          checkboxDefault: m.checkboxDefault,
        }),
      };
    case 'RENAME_LIST':
      await renameList(m.id, m.name);
      return { ok: true };
    case 'UPDATE_LIST':
      await updateList(m.id, m.patch);
      return { ok: true };
    case 'ARCHIVE_LIST':
      await archiveList(m.id);
      return { ok: true };
    case 'DELETE_LIST':
      await deleteListWithHighlights(m.id);
      return { ok: true };
    case 'UPDATE_LIST_ORDER':
      await reorderLists(m.orderedIds);
      return { ok: true };

    case 'GET_HIGHLIGHTS': {
      const highlights = await getHighlightsByList(m.listId);
      highlights.sort((a, b) => a.displayOrder - b.displayOrder);
      return { highlights };
    }
    case 'SAVE_HIGHLIGHT':
      return {
        id: await createHighlight({
          text: m.text,
          conversationTitle: m.conversationTitle,
          listId: m.listId,
          folderId: m.folderId,
          conversationUrl: m.conversationUrl ?? null,
        }),
      };
    case 'MOVE_HIGHLIGHT': {
      const dest = (await getListsByFolder(m.toFolderId)).find((l) => l.id === m.toListId);
      if (!dest) throw new Error(`Destination list ${m.toListId} not found`);
      const folder = (await getAllFolders()).find((f) => f.id === m.toFolderId);
      const generalId = await getMeta('generalFolderId');
      await updateHighlight(m.highlightId, {
        listId: m.toListId,
        folderId: m.toFolderId,
        conversationTitle: folder?.id === generalId ? '' : folder?.name ?? '',
        checkboxChecked: dest.checkboxDefault ? false : undefined,
        displayOrder: await nextHighlightOrder(m.toListId),
      });
      return { ok: true };
    }
    case 'REORDER_HIGHLIGHTS':
      await reorderHighlights(m.orderedIds);
      return { ok: true };
    case 'DELETE_HIGHLIGHT':
      await deleteHighlight(m.id);
      return { ok: true };
    case 'UPDATE_HIGHLIGHT':
      await updateHighlight(m.id, m.patch);
      return { ok: true };

    default:
      console.warn('[Stash SW] Unknown message type:', m?.type);
      return { error: `Unknown message type: ${m?.type}` };
  }
}
