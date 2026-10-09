// §3.2 folder system business logic.

import {
  createFolder,
  updateFolder,
  deleteFolder,
  getAllFolders,
  getFolderByName,
  getFoldersByParent,
  getListsByFolder,
  updateList,
  getMeta,
  setMeta,
  deleteConversationFolderCascade,
  deleteProjectFolderCascade,
  deleteManualFolderCascade,
} from '../db/db.js';
import { seedListsIntoFolder, seedGeneralFolder } from '../lists/lists.js';

// ─── General folder ──────────────────────────────────────────────────────────

// Returns the id of the General root folder, creating it once if it doesn't exist.
export async function ensureGeneralFolder() {
  let id = await getMeta('generalFolderId');

  if (!id) {
    id = await createFolder({ type: 'general', name: 'General', colour: null, parentId: null });
    await setMeta('generalFolderId', id);
    console.log('[Stash] General folder created, id:', id);
  }

  // Seed default lists if the folder has none — handles both fresh installs
  // and existing DBs that pre-date the seeding change.
  const existing = await getListsByFolder(id);
  if (existing.length === 0) {
    await seedGeneralFolder(id);
    console.log('[Stash] General folder seeded with default lists');
  }

  return id;
}

// ─── Duplicate name detection ────────────────────────────────────────────────
// §3.2: any new folder matching an existing folder name of any type gets a timestamp suffix.

async function uniqueFolderName(desiredName) {
  const existing = await getFolderByName(desiredName);
  if (!existing) return desiredName;
  const suffix = new Date().toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  return `${desiredName} · ${suffix}`;
}

// ─── Auto-create on highlight save ───────────────────────────────────────────

// §3.2 save flow. Returns { conversationFolderId, listIds }.
// Seeding completes before returning — caller opens the save popover after this resolves.
export async function ensureConversationFolder(conversationTitle, projectName, conversationId) {
  const generalId = await ensureGeneralFolder();

  let parentId = generalId;

  if (projectName) {
    parentId = await ensureProjectFolder(projectName, generalId);
  }

  // Check if a conversation folder with this title already exists under parentId.
  // Match by conversationId first (survives renames), fall back to name for older folders.
  const siblings = await getFoldersByParent(parentId);
  const found = siblings.find(
    (f) => f.type === 'conversation' &&
      (conversationId ? f.conversationId === conversationId : f.name === conversationTitle)
  );
  if (found) {
    if (conversationId && !found.conversationId) {
      await updateFolder(found.id, { conversationId });
    }
    const lists = await getListsByFolder(found.id);
    return { conversationFolderId: found.id, listIds: lists.map((l) => l.id) };
  }

  const name = await uniqueFolderName(conversationTitle);
  const conversationFolderId = await createFolder({
    type: 'conversation',
    name,
    colour: null,
    parentId,
    conversationId: conversationId ?? null,
  });

  // §3.2: seed before save popover opens.
  const listIds = await seedListsIntoFolder(conversationFolderId);
  console.log('[Stash] Conversation folder created and seeded:', name, '— lists:', listIds);

  return { conversationFolderId, listIds };
}

async function ensureProjectFolder(projectName) {
  const generalId = await ensureGeneralFolder();

  // Project folders live at root (parentId = generalId per spec two-tier max).
  // They are not inside General logically but use generalId as a sentinel parent
  // to satisfy the two-tier rule. They are distinguished by type: 'project'.
  const allFolders = await getAllFolders();
  const existing = allFolders.find((f) => f.type === 'project' && f.name === projectName);
  if (existing) return existing.id;

  const name = await uniqueFolderName(projectName);
  const id = await createFolder({ type: 'project', name, colour: null, parentId: null });
  console.log('[Stash] Project folder created:', name, 'id:', id);
  return id;
}

// §3.2 manual folder creation.
export async function createManualFolder(name, colour) {
  const uniqueName = await uniqueFolderName(name);
  return createFolder({ type: 'manual', name: uniqueName, colour, parentId: null });
}

// ─── Rename ───────────────────────────────────────────────────────────────────
// §3.2: manual renames after creation — silent allow, no uniqueness enforced.

export async function renameFolder(id, name) {
  return updateFolder(id, { name });
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export async function deleteFolderById(id) {
  const folders = await getAllFolders();
  const folder = folders.find((f) => f.id === id);
  if (!folder) {
    console.error('[Stash] deleteFolderById: folder not found:', id);
    throw new Error(`Folder ${id} not found`);
  }

  if (folder.type === 'general') {
    console.error('[Stash] deleteFolderById: General folder cannot be deleted');
    throw new Error('General folder cannot be deleted');
  }

  if (folder.type === 'conversation' || folder.type === 'project') {
    const cascade =
      folder.type === 'conversation'
        ? deleteConversationFolderCascade
        : deleteProjectFolderCascade;
    await cascade(id);
    console.log('[Stash] Folder cascade deleted:', folder.name, id);
    return;
  }

  if (folder.type === 'manual') {
    // §3.2: conversation folders nested inside are moved to General, not deleted.
    const movedIds = await deleteManualFolderCascade(id);
    const generalId = await ensureGeneralFolder();
    for (const convId of movedIds) {
      await updateFolder(convId, { parentId: generalId });
    }
    console.log('[Stash] Manual folder deleted; moved conversation folders to General:', movedIds);
  }
}

// ─── Migration ────────────────────────────────────────────────────────────────
// Exposed here for use by migration.js — moves a list's folderId.
export async function reassignListFolder(listId, newFolderId) {
  return updateList(listId, { folderId: newFolderId });
}
