// §3.2 one-time migration: on first load after folder system ships,
// pre-existing highlights are grouped by conversationTitle into conversation
// folders inside General. Runs once; gated by 'migrationComplete' meta flag.

import { getMeta, setMeta, getAllFolders, getListsByFolder, getHighlightsByList, updateList, updateHighlight, createFolder } from '../db/db.js';
import { ensureGeneralFolder } from '../folders/folders.js';
import { seedListsIntoFolder } from '../lists/lists.js';

export async function runMigrationIfNeeded() {
  const done = await getMeta('migrationComplete');
  if (done) return;

  console.log('[Stash] Running first-load migration...');

  const generalId = await ensureGeneralFolder();
  const allFolders = await getAllFolders();

  // Find any lists that currently live at the root (no folderId, or folderId pointing
  // to a now-deleted/non-existent folder) — these are pre-folder-system loose lists.
  const validFolderIds = new Set(allFolders.map((f) => f.id));
  const allLists = [];
  for (const folder of allFolders) {
    const lists = await getListsByFolder(folder.id);
    allLists.push(...lists);
  }

  // Group loose lists by their highlights' conversationTitle.
  // A list is "loose" if its folderId doesn't exist in the current folder set.
  const looseLists = allLists.filter((l) => !validFolderIds.has(l.folderId));

  if (looseLists.length === 0) {
    console.log('[Stash] Migration: no loose lists found, marking complete');
    await setMeta('migrationComplete', true);
    return;
  }

  // Group by conversationTitle derived from highlights.
  const titleToListIds = new Map();
  for (const list of looseLists) {
    const highlights = await getHighlightsByList(list.id);
    const title = highlights[0]?.conversationTitle ?? 'Untitled';
    if (!titleToListIds.has(title)) titleToListIds.set(title, []);
    titleToListIds.get(title).push(list.id);
  }

  // Create one conversation folder per unique title and move lists into it.
  // §3.2: duplicate loose list names are permitted inside a folder — silent allow.
  for (const [title, listIds] of titleToListIds) {
    const convFolderId = await createFolder({
      type: 'conversation',
      name: title,
      colour: null,
      parentId: generalId,
    });

    // Seed the new folder with the six default lists.
    await seedListsIntoFolder(convFolderId);

    // Move the migrated loose lists into this folder.
    for (const listId of listIds) {
      await updateList(listId, { folderId: convFolderId });
      const highlights = await getHighlightsByList(listId);
      for (const h of highlights) {
        await updateHighlight(h.id, { folderId: convFolderId, conversationTitle: title });
      }
    }

    console.log(`[Stash] Migration: created folder "${title}" (id ${convFolderId}), moved lists:`, listIds);
  }

  await setMeta('migrationComplete', true);
  console.log('[Stash] Migration complete');
}
