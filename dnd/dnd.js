// §1.1 drag-and-drop engine.
// Handles reorder within a list and move between lists.
// All data mutations go through sendMessage to the service worker.

import { sendMessage } from '../shared/messaging.js';

// ─── State ────────────────────────────────────────────────────────────────────

let dragging = null;
let indicator = null;
let dropTarget = null;
let _onDropComplete = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initDnd(root, { onDropComplete }) {
  _onDropComplete = onDropComplete;
  root.addEventListener('mousedown', onHandleMousedown);
  document.addEventListener('mousemove', onMousemove);
  document.addEventListener('mouseup', onMouseup);
  return { bindHandles: () => bindHandles(root) };
}

function bindHandles(root) {
  root.querySelectorAll('.stash-highlight-item__drag-handle').forEach((handle) => {
    handle.dataset.bound = '1';
  });
}

// ─── Drag start ───────────────────────────────────────────────────────────────

function onHandleMousedown(e) {
  const handle = e.target.closest('.stash-highlight-item__drag-handle');
  if (!handle) return;

  const item = handle.closest('.stash-highlight-item');
  if (!item) return;

  e.preventDefault();

  const highlightId = Number(item.dataset.highlightId);
  const sourceListId = Number(item.dataset.listId);
  const sourceFolderId = Number(item.dataset.folderId);

  if (!highlightId || !sourceListId) {
    console.error('[Stash DnD] Missing data attributes on drag item:', item.dataset);
    return;
  }

  const rect = item.getBoundingClientRect();

  // Ghost appended to document.body — NOT the shadow root.
  // The shadow root's host has transform: translateX(...), which makes any
  // position:fixed child relative to the host, not the viewport. By appending
  // to document.body we stay in the normal fixed-positioning context.
  const ghost = document.createElement('div');
  const text = item.querySelector('.stash-highlight-item__text')?.textContent ?? '';
  Object.assign(ghost.style, {
    position: 'fixed',
    zIndex: '2147483646',
    pointerEvents: 'none',
    background: '#fff',
    border: '1px solid #3b82f6',
    borderRadius: '6px',
    padding: '8px 10px',
    fontSize: '13px',
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
    color: '#374151',
    boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
    maxWidth: `${rect.width}px`,
    width: `${rect.width}px`,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    opacity: '0.9',
  });
  ghost.textContent = text;
  document.body.appendChild(ghost);

  item.classList.add('stash-highlight-item--dragging');

  const shadowRoot = item.getRootNode();
  indicator = document.createElement('div');
  indicator.className = 'stash-drop-indicator';
  indicator.style.display = 'none';
  shadowRoot.querySelector('.stash-highlights')?.appendChild(indicator);

  dragging = {
    highlightId,
    sourceListId,
    sourceFolderId,
    el: item,
    ghost,
    offsetX: e.clientX - rect.left,
    offsetY: e.clientY - rect.top,
  };
}

// ─── Drag move ────────────────────────────────────────────────────────────────

function onMousemove(e) {
  if (!dragging) return;

  dragging.ghost.style.left = `${e.clientX - dragging.offsetX}px`;
  dragging.ghost.style.top  = `${e.clientY - dragging.offsetY}px`;

  updateDropTarget(e, dragging.el.getRootNode());
}

function updateDropTarget(e, root) {
  const items = Array.from(
    root.querySelectorAll('.stash-highlight-item:not(.stash-highlight-item--dragging)')
  );
  const listHeaders = Array.from(root.querySelectorAll('.stash-list__header'));

  // List header drop → append to bottom of that list (§1.1).
  for (const header of listHeaders) {
    const r = header.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right &&
        e.clientY >= r.top  && e.clientY <= r.bottom) {
      const listId   = Number(header.dataset.listId);
      const folderId = Number(header.dataset.folderId);
      if (!listId) continue;
      dropTarget = { listId, folderId, beforeHighlightId: null };
      if (indicator) indicator.style.display = 'none';
      return;
    }
  }

  // Find the nearest item midpoint.
  let best = null;
  let bestDist = Infinity;
  for (const item of items) {
    const r = item.getBoundingClientRect();
    const midY = r.top + r.height / 2;
    const dist = Math.abs(e.clientY - midY);
    if (dist < bestDist) { bestDist = dist; best = { item, r, midY }; }
  }

  if (!best) {
    if (indicator) indicator.style.display = 'none';
    dropTarget = null;
    return;
  }

  const insertBefore = e.clientY < best.midY;

  dropTarget = {
    listId: Number(best.item.dataset.listId),
    folderId: Number(best.item.dataset.folderId),
    beforeHighlightId: insertBefore ? Number(best.item.dataset.highlightId) : null,
  };

  // Position the indicator relative to .stash-highlights (which is position:relative).
  if (indicator) {
    const container = root.querySelector('.stash-highlights');
    if (container) {
      const containerRect = container.getBoundingClientRect();
      const scrollTop = container.scrollTop;
      indicator.style.display = 'block';
      indicator.style.position = 'absolute';
      indicator.style.left = '8px';
      indicator.style.right = '8px';
      indicator.style.top = insertBefore
        ? `${best.r.top  - containerRect.top + scrollTop - 1}px`
        : `${best.r.bottom - containerRect.top + scrollTop + 1}px`;
    }
  }
}

// ─── Drag end ─────────────────────────────────────────────────────────────────

async function onMouseup() {
  if (!dragging) return;

  dragging.ghost.remove();
  dragging.el.classList.remove('stash-highlight-item--dragging');
  if (indicator) { indicator.remove(); indicator = null; }

  const { highlightId, sourceListId } = dragging;
  const target = dropTarget;
  dragging = null;
  dropTarget = null;

  if (!target) return;

  const isSameList = target.listId === sourceListId;

  if (isSameList) {
    await reorderInList(highlightId, sourceListId, target.beforeHighlightId);
    _onDropComplete?.({ sourceListId, targetListId: sourceListId });
  } else {
    await moveBetweenLists(highlightId, target.listId, target.folderId);
    _onDropComplete?.({ sourceListId, targetListId: target.listId, targetFolderId: target.folderId, highlightId });
  }
}

// ─── Data mutations ───────────────────────────────────────────────────────────

async function reorderInList(highlightId, listId, beforeHighlightId) {
  let highlights;
  try {
    const res = await sendMessage({ type: 'GET_HIGHLIGHTS', listId });
    highlights = res.highlights;
  } catch (err) {
    console.error('[Stash DnD] Failed to fetch highlights for reorder:', err);
    return;
  }

  const others  = highlights.filter((h) => h.id !== highlightId);
  const dragged = highlights.find((h) => h.id === highlightId);
  if (!dragged) {
    console.error('[Stash DnD] Dragged highlight not found in list:', highlightId);
    return;
  }

  let insertIdx = others.length;
  if (beforeHighlightId) {
    const idx = others.findIndex((h) => h.id === beforeHighlightId);
    if (idx !== -1) insertIdx = idx;
  }

  others.splice(insertIdx, 0, dragged);

  try {
    await sendMessage({ type: 'REORDER_HIGHLIGHTS', orderedIds: others.map((h) => h.id) });
  } catch (err) {
    console.error('[Stash DnD] REORDER_HIGHLIGHTS failed:', err);
  }
}

async function moveBetweenLists(highlightId, toListId, toFolderId) {
  try {
    await sendMessage({ type: 'MOVE_HIGHLIGHT', highlightId, toListId, toFolderId });
  } catch (err) {
    console.error('[Stash DnD] MOVE_HIGHLIGHT failed:', err);
  }
}
