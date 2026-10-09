// §3.1 custom list business logic.
// All DB calls are in db.js — this layer adds the rules on top.

import {
  createList,
  updateList,
  deleteList,
  getListsByFolder,
  deleteHighlightsByList,
} from '../db/db.js';

// §7 seeded list definitions — checkbox defaults per list name.
export const SEEDED_LISTS = [
  { name: 'To-do',          colour: '#6B7280', checkboxDefault: true  },
  { name: 'Ideas backlog',  colour: '#6B7280', checkboxDefault: false },
  { name: 'Questions',      colour: '#6B7280', checkboxDefault: true  },
  { name: 'Decisions made', colour: '#6B7280', checkboxDefault: false },
  { name: 'Client-facing',  colour: '#6B7280', checkboxDefault: true  },
  { name: 'Code snippets',  colour: '#6B7280', checkboxDefault: false },
];

// Default lists seeded once into the General folder on first install.
// Users can delete them; no special protection.
export const GENERAL_SEEDED_LISTS = [
  { name: 'To-do',     colour: '#EF4444', checkboxDefault: true  },
  { name: 'Questions', colour: '#3B82F6', checkboxDefault: true  },
  { name: 'Important', colour: '#F97316', checkboxDefault: false },
];

// Seeds the three default lists into a newly created conversation folder.
// Uses the same set as General so colour coding is consistent.
// Must complete before the save popover opens (§3.2).
export async function seedListsIntoFolder(folderId) {
  const ids = [];
  for (let i = 0; i < GENERAL_SEEDED_LISTS.length; i++) {
    const def = GENERAL_SEEDED_LISTS[i];
    const id = await createList({
      folderId,
      name: def.name,
      colour: def.colour,
      checkboxDefault: def.checkboxDefault,
      displayOrder: i,
      isSeeded: true,
    });
    ids.push(id);
  }
  return ids;
}

// Seeds the three default lists into the General folder on first creation.
export async function seedGeneralFolder(folderId) {
  const ids = [];
  for (let i = 0; i < GENERAL_SEEDED_LISTS.length; i++) {
    const def = GENERAL_SEEDED_LISTS[i];
    const id = await createList({
      folderId,
      name: def.name,
      colour: def.colour,
      checkboxDefault: def.checkboxDefault,
      displayOrder: i,
      isSeeded: true,
    });
    ids.push(id);
  }
  return ids;
}

// §3.1 create a user-created custom list.
export async function createCustomList({ folderId, name, colour, checkboxDefault }) {
  const existing = await getListsByFolder(folderId);
  const displayOrder = existing.length;
  return createList({ folderId, name, colour, checkboxDefault, displayOrder, isSeeded: false });
}

export async function renameList(id, name) {
  return updateList(id, { name });
}

export async function archiveList(id) {
  return updateList(id, { isArchived: true });
}

// §3.1: seeded lists have no special protection — delete applies equally.
export async function deleteListWithHighlights(id) {
  await deleteHighlightsByList(id);
  await deleteList(id);
}
