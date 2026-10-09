// Sidebar UI — renders into the Shadow DOM root provided by sidebar-host.js.
// All data comes from the service worker via sendMessage.

import { sendMessage } from '../../shared/messaging.js';
import { initDnd } from '../../dnd/dnd.js';
import { toggleSidebar, getHostElement } from '../sidebar-host.js';

// Colour palette for list/folder creation (§3.1: 8–12 presets, no hex input).
const PALETTE = [
  '#6B7280', '#EF4444', '#F97316', '#EAB308',
  '#22C55E', '#3B82F6', '#8B5CF6', '#EC4899',
];

// ─── State ────────────────────────────────────────────────────────────────────

let root = null; // Shadow DOM root
let dnd = null;

let state = {
  folders: [],
  generalId: null,
  // folderId → list[]
  listsByFolder: {},
  // listId → highlight[]
  highlightsByList: {},
  activeListId: null,
  activeFolderId: null,
  expandedFolders: new Set(),
  // UI modes
  creatingList: null,   // folderId | null
  creatingFolder: false,
  ctxMenu: null,        // { type, id, x, y }
  notice: null,         // string | null — auto-dismissing banner
  selectingHighlights: false,
  selectedHighlightIds: new Set(),
  selectingFolders: false,
  selectedFolderIds: new Set(),
};

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function initSidebar(shadowRoot) {
  root = shadowRoot;

  const container = document.createElement('div');
  container.id = 'stash-sidebar';
  root.appendChild(container);

  dnd = initDnd(root, {
    onDropComplete: async ({ sourceListId, targetListId, targetFolderId, highlightId }) => {
      // Reload highlights for any list that changed.
      await loadHighlightsForList(sourceListId);
      if (targetListId !== sourceListId) {
        await loadHighlightsForList(targetListId);
        // Switch the active list to wherever the item landed.
        state.activeListId  = targetListId;
        state.activeFolderId = targetFolderId ?? state.activeFolderId;
        if (targetFolderId) state.expandedFolders.add(targetFolderId);

        // Recolour the DOM mark to match the destination list.
        if (highlightId != null) {
          const targetList = Object.values(state.listsByFolder).flat().find((l) => l.id === targetListId);
          if (targetList?.colour) {
            const mark = document.querySelector(`[data-stash-highlight-id="${highlightId}"]`);
            if (mark) recolourMark(mark, targetList.colour);
          }
        }
      }
      render();
    },
  });

  await loadAndRender();

  // After a highlight is saved, switch to that list and refresh.
  // Also reload the folder list — ENSURE_CONVERSATION_FOLDER may have just
  // auto-created a new folder that the tree doesn't know about yet.
  window.addEventListener('stash:highlight-saved', async (e) => {
    const { listId, folderId } = e.detail;
    state.activeListId  = listId;
    state.activeFolderId = folderId;
    try {
      const res = await sendMessage({ type: 'GET_FOLDERS' });
      state.folders  = res.folders;
      state.generalId = res.generalId;
    } catch (err) {
      console.error('[Stash Sidebar] Failed to reload folders after save:', err);
    }
    // Expand the saved folder and its ancestors (but not General — conv folders
    // are rendered at root level, so General doesn't need to be open).
    let f = state.folders.find((x) => x.id === folderId);
    while (f && f.type !== 'general') {
      state.expandedFolders.add(f.id);
      f = f.parentId ? state.folders.find((x) => x.id === f.parentId) : null;
    }
    await loadListsForFolder(folderId);
    await loadHighlightsForList(listId);
    render();
  });

  // Close context menu on outside click.
  root.addEventListener('mousedown', (e) => {
    if (state.ctxMenu && !e.target.closest('.stash-ctx-menu')) {
      closeCtxMenu();
    }
  });

  // Validity check: auto-deleted a stale highlight.
  window.addEventListener('stash:highlight-auto-deleted', (e) => {
    const { highlightId, listId } = e.detail;
    removeHighlightFromState(highlightId, listId);
    renderHighlights();
    if (isSidebarVisible()) showNotice('A highlight was removed — its source text no longer exists.');
  });

  // Navigation: highlight text not found in DOM — immediate delete.
  window.addEventListener('stash:highlight-not-found', async (e) => {
    const { highlightId, listId } = e.detail;
    try {
      await sendMessage({ type: 'DELETE_HIGHLIGHT', id: highlightId });
      window.dispatchEvent(new CustomEvent('stash:highlight-deleted', { detail: { highlightId } }));
      removeHighlightFromState(highlightId, listId);
      renderHighlights();
      if (isSidebarVisible()) showNotice('Source text not found — highlight removed.');
    } catch (err) {
      console.error('[Stash Sidebar] Failed to delete not-found highlight:', err);
    }
  });
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function recolourMark(mark, colour) {
  const h = colour.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  mark.style.setProperty('background',    `rgba(${r}, ${g}, ${b}, 0.28)`, 'important');
  mark.style.setProperty('border-bottom', `2px solid ${colour}`,           'important');
}

// ─── Data loading ─────────────────────────────────────────────────────────────

async function loadAndRender() {
  try {
    const res = await sendMessage({ type: 'GET_FOLDERS' });
    state.folders = res.folders;
    state.generalId = res.generalId;
    render();
  } catch (err) {
    console.error('[Stash Sidebar] Failed to load folders:', err);
    renderError('Failed to load folders.');
  }
}

async function loadListsForFolder(folderId) {
  try {
    const res = await sendMessage({ type: 'GET_LISTS', folderId });
    state.listsByFolder[folderId] = res.lists;
  } catch (err) {
    console.error('[Stash Sidebar] Failed to load lists for folder:', folderId, err);
    state.listsByFolder[folderId] = [];
  }
}

async function loadHighlightsForList(listId) {
  try {
    const res = await sendMessage({ type: 'GET_HIGHLIGHTS', listId });
    state.highlightsByList[listId] = res.highlights;
  } catch (err) {
    console.error('[Stash Sidebar] Failed to load highlights for list:', listId, err);
    state.highlightsByList[listId] = [];
  }
}

async function refreshActiveList() {
  if (state.activeListId === null) return;
  await loadHighlightsForList(state.activeListId);
  renderHighlights();
}

// ─── Render ───────────────────────────────────────────────────────────────────

function render() {
  const container = root.getElementById('stash-sidebar');
  container.innerHTML = '';
  container.appendChild(buildHeader());
  container.appendChild(buildTree());
  renderHighlightsInto(container);
  closeCtxMenu();
}

function renderError(msg) {
  const container = root.getElementById('stash-sidebar');
  container.innerHTML = `<p style="padding:16px;color:#ef4444">${msg}</p>`;
}

function renderHighlights() {
  const container = root.getElementById('stash-sidebar');
  const existing = container.querySelector('.stash-highlights');
  if (existing) existing.remove();
  renderHighlightsInto(container);
}

function renderHighlightsInto(container) {
  container.appendChild(buildHighlightsPanel());
}

// ─── Header ───────────────────────────────────────────────────────────────────

function buildHeader() {
  const header = el('div', 'stash-header');
  const title = el('h1', 'stash-header__title', 'Stash');
  const closeBtn = el('button', 'stash-header__btn', '✕');
  closeBtn.title = 'Close Stash';
  closeBtn.addEventListener('click', toggleSidebar);
  header.append(title, closeBtn);
  return header;
}

// ─── Folder tree ──────────────────────────────────────────────────────────────

function buildTree() {
  const tree = el('div', 'stash-tree');

  const generalFolder  = state.folders.find((f) => f.id === state.generalId && f.type === 'general');
  const projectFolders = state.folders.filter((f) => f.type === 'project');
  const manualFolders  = state.folders.filter((f) => f.type === 'manual');
  // Conversation folders whose parent is General appear at root, not nested inside General.
  const rootConvFolders = state.folders.filter(
    (f) => f.type === 'conversation' && f.parentId === state.generalId
  );

  if (generalFolder) tree.appendChild(buildFolderNode(generalFolder));
  rootConvFolders.forEach((f) => tree.appendChild(buildFolderNode(f)));
  projectFolders.forEach((f) => tree.appendChild(buildFolderNode(f)));
  manualFolders.forEach((f) => tree.appendChild(buildFolderNode(f)));

  // Bottom row: + New folder button + Select button
  const bottomRow = el('div', 'stash-tree-bottom-row');

  const addFolderBtn = el('button', 'stash-add-btn', '+ New folder');
  addFolderBtn.addEventListener('click', () => {
    state.creatingFolder = true;
    render();
  });

  if (!state.selectingFolders) {
    bottomRow.appendChild(addFolderBtn);

    const selectBtn = el('button', 'stash-select-btn', 'Select');
    selectBtn.addEventListener('click', () => {
      state.selectingFolders = true;
      state.selectedFolderIds.clear();
      render();
    });
    bottomRow.appendChild(selectBtn);
  } else {
    bottomRow.appendChild(buildFolderSelectFooter());
  }

  tree.appendChild(bottomRow);

  if (state.creatingFolder) {
    tree.appendChild(buildCreateFolderForm());
  }

  return tree;
}

function buildFolderSelectFooter() {
  const footer = el('div', 'stash-tree-select-footer');

  const doneBtn = el('button', 'stash-btn', 'Done');
  doneBtn.addEventListener('click', () => {
    state.selectingFolders = false;
    state.selectedFolderIds.clear();
    render();
  });

  const selCount = state.selectedFolderIds.size;
  const deleteBtn = el('button', 'stash-btn--danger', `Delete ${selCount} folder${selCount !== 1 ? 's' : ''}`);
  deleteBtn.disabled = selCount === 0;
  deleteBtn.addEventListener('click', () => deleteSelectedFolders());

  footer.append(doneBtn, deleteBtn);
  return footer;
}

function buildFolderNode(folder) {
  const isExpanded = state.expandedFolders.has(folder.id);
  const node = el('div', `stash-folder${isExpanded ? '' : ' stash-folder--collapsed'}`);

  const isSelected = state.selectingFolders && state.selectedFolderIds.has(folder.id);
  let headerClass = 'stash-folder__header';
  if (isSelected) headerClass += ' stash-folder__header--selected';
  const header = el('div', headerClass);
  header.dataset.folderId = folder.id;
  header.dataset.listId = ''; // folder headers are not valid list drop targets
  const chevron = el('span', 'stash-folder__chevron', '▾');
  const nameSpan = el('span', 'stash-folder__name', folder.name);

  if (state.selectingFolders && folder.type !== 'general') {
    const folderCb = document.createElement('input');
    folderCb.type = 'checkbox';
    folderCb.className = 'stash-folder-select-cb';
    folderCb.checked = isSelected;
    folderCb.addEventListener('click', (e) => e.stopPropagation());
    folderCb.addEventListener('change', () => {
      if (folderCb.checked) {
        state.selectedFolderIds.add(folder.id);
      } else {
        state.selectedFolderIds.delete(folder.id);
      }
      render();
    });
    header.appendChild(folderCb);
  }

  header.append(chevron, nameSpan);

  if (!state.selectingFolders) {
    const menuBtn = el('button', 'stash-row-menu-btn', '⋯');
    menuBtn.title = 'Folder options';
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openCtxMenu(menuBtn, folder.type === 'general' ? 'folder-general' : 'folder', folder.id);
    });
    header.appendChild(menuBtn);
  }

  header.addEventListener('click', async (e) => {
    if (state.selectingFolders && folder.type !== 'general') {
      // Toggle selection when clicking the header (but not the chevron, which still expands)
      if (!e.target.closest('.stash-folder__chevron')) {
        if (state.selectedFolderIds.has(folder.id)) {
          state.selectedFolderIds.delete(folder.id);
        } else {
          state.selectedFolderIds.add(folder.id);
        }
        render();
        return;
      }
    }
    if (isExpanded) {
      state.expandedFolders.delete(folder.id);
    } else {
      state.expandedFolders.add(folder.id);
      if (!state.listsByFolder[folder.id]) {
        await loadListsForFolder(folder.id);
      }
    }
    render();
  });

  node.appendChild(header);

  if (isExpanded) {
    const children = el('div', 'stash-folder__children');

    // For project folders: show child conversation folders.
    if (folder.type === 'project' || folder.type === 'manual') {
      // Show child conversation folders nested inside project/manual folders.
      const convFolders = state.folders.filter(
        (f) => f.type === 'conversation' && f.parentId === folder.id
      );
      convFolders.forEach((cf) => children.appendChild(buildFolderNode(cf)));
    }

    if (folder.type !== 'project') {
      // Conversation, general, and manual folders: show their own lists.
      const lists = (state.listsByFolder[folder.id] ?? []).filter((l) => !l.isArchived);
      lists.sort((a, b) => a.displayOrder - b.displayOrder);
      lists.forEach((list) => children.appendChild(buildListRow(list, folder.id)));

      // + New list button.
      const addListBtn = el('button', 'stash-add-btn', '+ New list');
      addListBtn.addEventListener('click', () => {
        state.creatingList = folder.id;
        render();
      });
      children.appendChild(addListBtn);

      if (state.creatingList === folder.id) {
        children.appendChild(buildCreateListForm(folder.id));
      }
    }

    node.appendChild(children);
  }

  return node;
}

function buildListRow(list, folderId) {
  const row = el('div', `stash-list__header${list.id === state.activeListId ? ' stash-list__header--active' : ''}`);
  row.dataset.listId = list.id;
  row.dataset.folderId = folderId;

  const dot = el('span', 'stash-list__dot');
  dot.style.background = list.colour ?? PALETTE[0];
  const name = el('span', 'stash-list__name', list.name);

  const menuBtn = el('button', 'stash-row-menu-btn', '⋯');
  menuBtn.title = 'List options';
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openCtxMenu(menuBtn, 'list', list.id);
  });

  row.append(dot, name, menuBtn);

  row.addEventListener('click', async () => {
    state.selectingHighlights = false;
    state.selectedHighlightIds.clear();
    state.activeListId = list.id;
    state.activeFolderId = folderId;
    if (!state.highlightsByList[list.id]) {
      await loadHighlightsForList(list.id);
    }
    render();
  });

  return row;
}

// ─── Breadcrumb ───────────────────────────────────────────────────────────────

function buildBreadcrumb() {
  const crumb = el('div', 'stash-breadcrumb');

  if (state.activeListId === null || state.activeFolderId === null) return crumb;

  const activeFolder = state.folders.find((f) => f.id === state.activeFolderId);
  const activeList   = Object.values(state.listsByFolder).flat().find((l) => l.id === state.activeListId);

  if (!activeFolder || !activeList) return crumb;

  const parentFolder = activeFolder.parentId
    ? state.folders.find((f) => f.id === activeFolder.parentId)
    : null;

  // Show parent project folder if it is not General.
  if (parentFolder && parentFolder.type !== 'general') {
    crumb.append(
      el('span', 'stash-breadcrumb__part', parentFolder.name),
      el('span', 'stash-breadcrumb__sep', ' / '),
    );
  }

  // Show current folder unless it is General (General is implicit).
  if (activeFolder.type !== 'general') {
    crumb.append(
      el('span', 'stash-breadcrumb__part', activeFolder.name),
      el('span', 'stash-breadcrumb__sep', ' › '),
    );
  }

  // Coloured dot + list name.
  const dot = el('span', 'stash-breadcrumb__dot');
  dot.style.background = activeList.colour ?? '#6b7280';
  crumb.append(dot, el('span', 'stash-breadcrumb__active', activeList.name));

  const highlights = state.highlightsByList[state.activeListId] ?? [];
  if (highlights.length > 0) {
    const selectBtn = el('button', 'stash-breadcrumb__select-btn', 'Select');
    selectBtn.addEventListener('click', () => {
      state.selectingHighlights = true;
      state.selectedHighlightIds.clear();
      renderHighlights();
    });
    crumb.appendChild(selectBtn);
  }

  return crumb;
}

// ─── Highlights panel ─────────────────────────────────────────────────────────

function buildHighlightsPanel() {
  const panel = el('div', 'stash-highlights');

  if (state.activeListId === null) {
    panel.appendChild(buildBreadcrumb());
    if (state.notice) {
      panel.appendChild(el('div', 'stash-notice', state.notice));
    }
    panel.appendChild(el('p', 'stash-empty', 'Select a list to view highlights.'));
    return panel;
  }

  const highlights = (state.highlightsByList[state.activeListId] ?? []).slice();
  highlights.sort((a, b) => a.displayOrder - b.displayOrder);

  if (state.selectingHighlights && highlights.length > 0) {
    panel.appendChild(buildHighlightSelectBar(highlights));
  } else {
    panel.appendChild(buildBreadcrumb());
  }

  if (state.notice) {
    panel.appendChild(el('div', 'stash-notice', state.notice));
  }

  if (highlights.length === 0) {
    panel.appendChild(el('p', 'stash-empty', 'No highlights yet. Select text on the page and click the pin button.'));
    return panel;
  }

  const list = Object.values(state.listsByFolder)
    .flat()
    .find((l) => l.id === state.activeListId);
  const checkboxOn = list?.checkboxDefault ?? false;

  highlights.forEach((h) => panel.appendChild(buildHighlightItem(h, checkboxOn)));
  if (!state.selectingHighlights) {
    dnd.bindHandles();
  }
  return panel;
}

function buildHighlightSelectBar(highlights) {
  const bar = el('div', 'stash-select-bar');

  const selCount = state.selectedHighlightIds.size;
  const allSelected = selCount === highlights.length;
  const someSelected = selCount > 0 && !allSelected;

  const selectAllCb = document.createElement('input');
  selectAllCb.type = 'checkbox';
  selectAllCb.checked = allSelected;
  selectAllCb.indeterminate = someSelected;
  selectAllCb.addEventListener('change', () => {
    if (selectAllCb.checked) {
      highlights.forEach((h) => state.selectedHighlightIds.add(h.id));
    } else {
      state.selectedHighlightIds.clear();
    }
    renderHighlights();
  });

  const countLabel = el('span', 'stash-select-bar__count', selCount > 0 ? `${selCount} selected` : 'Select items');

  const deleteBtn = el('button', 'stash-select-bar__delete', `Delete ${selCount}`);
  deleteBtn.disabled = selCount === 0;
  deleteBtn.addEventListener('click', () => deleteSelectedHighlights());

  const doneBtn = el('button', 'stash-select-bar__done', 'Done');
  doneBtn.addEventListener('click', () => {
    state.selectingHighlights = false;
    state.selectedHighlightIds.clear();
    renderHighlights();
  });

  bar.append(selectAllCb, countLabel, deleteBtn, doneBtn);
  return bar;
}

function buildHighlightItem(h, checkboxOn) {
  const isSelected = state.selectedHighlightIds.has(h.id);
  let className = 'stash-highlight-item';
  if (state.selectingHighlights) className += ' stash-highlight-item--selecting';
  if (state.selectingHighlights && isSelected) className += ' stash-highlight-item--selected';

  const item = el('div', className);
  item.dataset.highlightId = h.id;
  item.dataset.listId = h.listId;
  item.dataset.folderId = h.folderId;

  if (state.selectingHighlights) {
    item.addEventListener('click', () => {
      if (state.selectedHighlightIds.has(h.id)) {
        state.selectedHighlightIds.delete(h.id);
      } else {
        state.selectedHighlightIds.add(h.id);
      }
      renderHighlights();
    });

    const selCb = document.createElement('input');
    selCb.type = 'checkbox';
    selCb.className = 'stash-highlight-item__select-cb';
    selCb.checked = isSelected;
    selCb.addEventListener('click', (e) => e.stopPropagation());
    selCb.addEventListener('change', () => {
      if (selCb.checked) {
        state.selectedHighlightIds.add(h.id);
      } else {
        state.selectedHighlightIds.delete(h.id);
      }
      renderHighlights();
    });

    const text = el('p', 'stash-highlight-item__text', h.text);
    item.append(selCb, text);
    return item;
  }

  const handle = el('span', 'stash-highlight-item__drag-handle', '⠷');
  handle.title = 'Drag to reorder or move';

  const text = el('p', 'stash-highlight-item__text', h.text);

  const del = el('button', 'stash-highlight-item__delete', '×');
  del.title = 'Delete highlight';
  del.addEventListener('click', () => deleteHighlight(h.id));

  // Build child list: handle → [checkbox] → text → [nav] → del
  const children = [handle];

  if (checkboxOn) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'stash-highlight-item__checkbox';
    cb.checked = !!h.checkboxChecked;
    cb.addEventListener('change', () => {
      sendMessage({ type: 'UPDATE_HIGHLIGHT', id: h.id, patch: { checkboxChecked: cb.checked } })
        .catch((err) => console.error('[Stash Sidebar] Failed to update checkbox:', err));
    });
    children.push(cb);
  }

  children.push(text);

  if (h.conversationUrl) {
    const navBtn = el('button', 'stash-highlight-item__nav', '↗');
    navBtn.title = 'Go to source';
    navBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigateToHighlight(h);
    });
    navBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openCtxMenu(e.target, 'nav', h.id);
    });
    children.push(navBtn);
  }

  children.push(del);
  item.append(...children);
  return item;
}

// ─── Context menu ─────────────────────────────────────────────────────────────

function openCtxMenu(triggerEl, type, id) {
  closeCtxMenu();
  state.ctxMenu = { type, id };

  // position: fixed inside the transformed host is relative to the host origin.
  // Subtract hostRect offset to convert viewport coords → host-local coords.
  const hostRect = getHostElement().getBoundingClientRect();
  const btnRect  = triggerEl.getBoundingClientRect();
  const top  = btnRect.bottom - hostRect.top + 2;
  const right = hostRect.right - btnRect.right + 4;

  const menu = el('div', 'stash-ctx-menu');
  menu.style.top   = `${top}px`;
  menu.style.right = `${right}px`;

  if (type === 'nav') {
    const h = findHighlightById(id);
    if (!h) return;
    menu.appendChild(ctxItem('Open in new tab', () => window.open(h.conversationUrl, '_blank')));
  } else if (type === 'list') {
    menu.appendChild(ctxItem('Rename', () => promptRenameList(id)));
    const colourBtn = document.createElement('button');
    colourBtn.className = 'stash-ctx-menu__item';
    colourBtn.textContent = 'Change colour';
    colourBtn.addEventListener('click', () => openColourPicker(id, menu));
    menu.appendChild(colourBtn);
    menu.appendChild(ctxItem('Toggle checkboxes', () => toggleListCheckboxes(id)));
    menu.appendChild(ctxItem('Archive', () => archiveList(id)));
    menu.appendChild(ctxItem('Delete', () => deleteList(id), true));
  } else if (type === 'folder-general') {
    menu.appendChild(ctxItem('Rename', () => promptRenameFolder(id)));
    // General folder cannot be deleted.
  } else if (type === 'folder') {
    menu.appendChild(ctxItem('Rename', () => promptRenameFolder(id)));
    menu.appendChild(ctxItem('Delete', () => doDeleteFolder(id), true));
  }

  root.appendChild(menu);
}

function closeCtxMenu() {
  state.ctxMenu = null;
  root.querySelector('.stash-ctx-menu')?.remove();
}

function ctxItem(label, action, danger = false) {
  const btn = el('button', `stash-ctx-menu__item${danger ? ' stash-ctx-menu__item--danger' : ''}`, label);
  btn.addEventListener('click', () => { closeCtxMenu(); action(); });
  return btn;
}

// ─── Create forms ─────────────────────────────────────────────────────────────

function buildCreateListForm(folderId) {
  const form = el('div', 'stash-create-form');

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'List name';

  let selectedColour = PALETTE[0];
  let checkboxDefault = false;

  const palette = el('div', 'stash-create-form__palette');
  PALETTE.forEach((colour) => {
    const swatch = el('span', `stash-colour-swatch${colour === selectedColour ? ' stash-colour-swatch--selected' : ''}`);
    swatch.style.background = colour;
    swatch.addEventListener('click', () => {
      palette.querySelectorAll('.stash-colour-swatch').forEach((s) => s.classList.remove('stash-colour-swatch--selected'));
      swatch.classList.add('stash-colour-swatch--selected');
      selectedColour = colour;
    });
    palette.appendChild(swatch);
  });

  const cbLabel = document.createElement('label');
  cbLabel.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.addEventListener('change', () => { checkboxDefault = cb.checked; });
  cbLabel.append(cb, 'Checkboxes on');

  const actions = el('div', 'stash-create-form__actions');
  const cancel = el('button', 'stash-btn', 'Cancel');
  cancel.addEventListener('click', () => { state.creatingList = null; render(); });
  const save = el('button', 'stash-btn stash-btn--primary', 'Create');
  save.addEventListener('click', async () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    try {
      await sendMessage({ type: 'CREATE_LIST', folderId, name, colour: selectedColour, checkboxDefault });
      state.creatingList = null;
      state.listsByFolder[folderId] = null; // invalidate cache
      await loadListsForFolder(folderId);
      render();
    } catch (err) {
      console.error('[Stash Sidebar] Failed to create list:', err);
    }
  });
  actions.append(cancel, save);

  form.append(input, palette, cbLabel, actions);
  return form;
}

function buildCreateFolderForm() {
  const form = el('div', 'stash-create-form');

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Folder name';

  let selectedColour = PALETTE[0];

  const palette = el('div', 'stash-create-form__palette');
  PALETTE.forEach((colour) => {
    const swatch = el('span', `stash-colour-swatch${colour === selectedColour ? ' stash-colour-swatch--selected' : ''}`);
    swatch.style.background = colour;
    swatch.addEventListener('click', () => {
      palette.querySelectorAll('.stash-colour-swatch').forEach((s) => s.classList.remove('stash-colour-swatch--selected'));
      swatch.classList.add('stash-colour-swatch--selected');
      selectedColour = colour;
    });
    palette.appendChild(swatch);
  });

  const actions = el('div', 'stash-create-form__actions');
  const cancel = el('button', 'stash-btn', 'Cancel');
  cancel.addEventListener('click', () => { state.creatingFolder = false; render(); });
  const save = el('button', 'stash-btn stash-btn--primary', 'Create');
  save.addEventListener('click', async () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    try {
      await sendMessage({ type: 'CREATE_MANUAL_FOLDER', name, colour: selectedColour });
      state.creatingFolder = false;
      await loadAndRender();
    } catch (err) {
      console.error('[Stash Sidebar] Failed to create folder:', err);
    }
  });
  actions.append(cancel, save);

  form.append(input, palette, actions);
  return form;
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function deleteHighlight(id) {
  try {
    await sendMessage({ type: 'DELETE_HIGHLIGHT', id });
    window.dispatchEvent(new CustomEvent('stash:highlight-deleted', { detail: { highlightId: id } }));
    delete state.highlightsByList[state.activeListId];
    await loadHighlightsForList(state.activeListId);
    renderHighlights();
  } catch (err) {
    console.error('[Stash Sidebar] Failed to delete highlight:', err);
  }
}

async function archiveList(id) {
  try {
    await sendMessage({ type: 'ARCHIVE_LIST', id });
    if (state.activeListId === id) { state.activeListId = null; state.activeFolderId = null; }
    const folderId = Object.keys(state.listsByFolder).find((fid) =>
      state.listsByFolder[fid]?.some((l) => l.id === id)
    );
    if (folderId) {
      state.listsByFolder[folderId] = null;
      await loadListsForFolder(Number(folderId));
    }
    render();
  } catch (err) {
    console.error('[Stash Sidebar] Failed to archive list:', err);
  }
}

async function deleteList(id) {
  try {
    await sendMessage({ type: 'DELETE_LIST', id });
    window.dispatchEvent(new CustomEvent('stash:list-deleted', { detail: { listId: id } }));
    if (state.activeListId === id) { state.activeListId = null; state.activeFolderId = null; }
    delete state.highlightsByList[id];
    const folderId = Object.keys(state.listsByFolder).find((fid) =>
      state.listsByFolder[fid]?.some((l) => l.id === id)
    );
    if (folderId) {
      state.listsByFolder[folderId] = null;
      await loadListsForFolder(Number(folderId));
    }
    render();
  } catch (err) {
    console.error('[Stash Sidebar] Failed to delete list:', err);
  }
}

function openColourPicker(listId, menuEl) {
  const list = Object.values(state.listsByFolder).flat().filter(Boolean).find((l) => l.id === listId);
  if (!list) return;
  const currentColour = list.colour ?? PALETTE[0];

  menuEl.innerHTML = '';

  const title = document.createElement('p');
  title.style.cssText = 'margin:4px 8px 2px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--stash-text-muted)';
  title.textContent = 'Pick colour';
  menuEl.appendChild(title);

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:6px;padding:6px 8px 4px;flex-wrap:wrap';

  PALETTE.forEach((colour) => {
    const sw = document.createElement('button');
    sw.style.cssText = `width:22px;height:22px;border-radius:50%;border:2px solid ${colour === currentColour ? 'var(--stash-text-primary)' : 'transparent'};background:${colour};cursor:pointer;padding:0;flex-shrink:0`;
    sw.addEventListener('click', async () => {
      try {
        await sendMessage({ type: 'UPDATE_LIST', id: listId, patch: { colour } });
        // Update inline styles on all DOM marks belonging to this list
        document.querySelectorAll(`[data-stash-list-id="${listId}"]`).forEach((mark) => {
          mark.style.setProperty('background', hexToRgba(colour, 0.28), 'important');
          mark.style.setProperty('border-bottom', `2px solid ${colour}`, 'important');
        });
        // Update local state cache so re-render uses the new colour
        Object.values(state.listsByFolder).forEach((lists) => {
          if (!lists) return;
          const found = lists.find((l) => l.id === listId);
          if (found) found.colour = colour;
        });
        closeCtxMenu();
        render();
      } catch (err) {
        console.error('[Stash Sidebar] Failed to update list colour:', err);
      }
    });
    row.appendChild(sw);
  });

  menuEl.appendChild(row);

  const cancel = document.createElement('button');
  cancel.className = 'stash-ctx-menu__item';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', closeCtxMenu);
  menuEl.appendChild(cancel);
}

async function toggleListCheckboxes(id) {
  const list = Object.values(state.listsByFolder).flat().filter(Boolean).find((l) => l.id === id);
  if (!list) return;
  const newVal = !(list.checkboxDefault ?? false);
  try {
    await sendMessage({ type: 'UPDATE_LIST', id, patch: { checkboxDefault: newVal } });
    Object.values(state.listsByFolder).forEach((lists) => {
      if (!lists) return;
      const found = lists.find((l) => l.id === id);
      if (found) found.checkboxDefault = newVal;
    });
    render();
  } catch (err) {
    console.error('[Stash Sidebar] Failed to toggle checkboxes:', err);
  }
}

async function promptRenameList(id) {
  const list = Object.values(state.listsByFolder).flat().find((l) => l.id === id);
  const name = prompt('Rename list:', list?.name ?? '');
  if (!name?.trim()) return;
  try {
    await sendMessage({ type: 'RENAME_LIST', id, name: name.trim() });
    const folderId = Object.keys(state.listsByFolder).find((fid) =>
      state.listsByFolder[fid]?.some((l) => l.id === id)
    );
    if (folderId) {
      state.listsByFolder[folderId] = null;
      await loadListsForFolder(Number(folderId));
    }
    render();
  } catch (err) {
    console.error('[Stash Sidebar] Failed to rename list:', err);
  }
}

async function promptRenameFolder(id) {
  const folder = state.folders.find((f) => f.id === id);
  const name = prompt('Rename folder:', folder?.name ?? '');
  if (!name?.trim()) return;
  try {
    await sendMessage({ type: 'RENAME_FOLDER', id, name: name.trim() });
    await loadAndRender();
  } catch (err) {
    console.error('[Stash Sidebar] Failed to rename folder:', err);
  }
}

// Returns the given folder ID plus all descendant folder IDs (recursive).
function getDescendantFolderIds(parentId) {
  const ids = [parentId];
  state.folders
    .filter((f) => f.parentId === parentId)
    .forEach((child) => ids.push(...getDescendantFolderIds(child.id)));
  return ids;
}

async function doDeleteFolder(id) {
  const folder = state.folders.find((f) => f.id === id);
  // Collect descendant IDs before deletion so we can clear page marks.
  const folderIds = getDescendantFolderIds(id);
  try {
    await sendMessage({ type: 'DELETE_FOLDER', id });
    window.dispatchEvent(new CustomEvent('stash:folder-deleted', { detail: { folderIds } }));
    if (state.activeFolderId === id || folderIds.includes(state.activeFolderId)) {
      state.activeListId = null;
      state.activeFolderId = null;
    }
    await loadAndRender();
  } catch (err) {
    console.error('[Stash Sidebar] Failed to delete folder:', err);
  }
}

async function deleteSelectedHighlights() {
  const ids = [...state.selectedHighlightIds];
  if (!ids.length) return;
  try {
    await Promise.all(ids.map((id) => sendMessage({ type: 'DELETE_HIGHLIGHT', id })));
    ids.forEach((id) =>
      window.dispatchEvent(new CustomEvent('stash:highlight-deleted', { detail: { highlightId: id } }))
    );
    state.selectedHighlightIds.clear();
    state.selectingHighlights = false;
    delete state.highlightsByList[state.activeListId];
    await loadHighlightsForList(state.activeListId);
    renderHighlights();
  } catch (err) {
    console.error('[Stash Sidebar] Failed to delete selected highlights:', err);
  }
}

function getAncestorFolderIds(folderId) {
  const folder = state.folders.find((f) => f.id === folderId);
  if (!folder || !folder.parentId) return [];
  return [folder.parentId, ...getAncestorFolderIds(folder.parentId)];
}

async function deleteSelectedFolders() {
  const ids = [...state.selectedFolderIds];
  if (!ids.length) return;
  const toDelete = ids.filter((id) => {
    const ancestors = getAncestorFolderIds(id);
    return !ancestors.some((aid) => state.selectedFolderIds.has(aid));
  });
  try {
    for (const id of toDelete) {
      const folderIds = getDescendantFolderIds(id);
      await sendMessage({ type: 'DELETE_FOLDER', id });
      window.dispatchEvent(new CustomEvent('stash:folder-deleted', { detail: { folderIds } }));
      if (state.activeFolderId === id || folderIds.includes(state.activeFolderId)) {
        state.activeListId = null;
        state.activeFolderId = null;
      }
    }
  } catch (err) {
    console.error('[Stash Sidebar] Failed to delete selected folders:', err);
  }
  state.selectedFolderIds.clear();
  state.selectingFolders = false;
  await loadAndRender();
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function isSameConversation(storedUrl) {
  try {
    const stored = new URL(storedUrl);
    const current = new URL(location.href);
    return current.pathname === stored.pathname;
  } catch {
    return false;
  }
}

function navigateToHighlight(h) {
  if (!h.conversationUrl) return;

  if (isSameConversation(h.conversationUrl)) {
    // Already on the right conversation — scroll directly.
    window.dispatchEvent(new CustomEvent('stash:scroll-to-highlight', {
      detail: { text: h.text, highlightId: h.id, listId: h.listId },
    }));
  } else {
    // Store scroll intent in sessionStorage — content/index.js picks it up after navigation.
    sessionStorage.setItem('stash:pending-scroll', JSON.stringify({
      text: h.text,
      highlightId: h.id,
      listId: h.listId,
      targetUrl: h.conversationUrl,
    }));
    location.assign(h.conversationUrl);
  }
}

// ─── Sidebar state helpers ────────────────────────────────────────────────────

function findHighlightById(id) {
  return Object.values(state.highlightsByList).flat().find((h) => h.id === id) ?? null;
}

function removeHighlightFromState(highlightId, listId) {
  if (listId && state.highlightsByList[listId]) {
    state.highlightsByList[listId] = state.highlightsByList[listId]
      .filter((h) => h.id !== highlightId);
  }
}

function isSidebarVisible() {
  return getHostElement()?.style.display !== 'none';
}

// ─── Notice banner ────────────────────────────────────────────────────────────

let _noticeTimer = null;

function showNotice(text) {
  state.notice = text;
  clearTimeout(_noticeTimer);
  renderHighlights();
  _noticeTimer = setTimeout(() => {
    state.notice = null;
    renderHighlights();
  }, 5000);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}
