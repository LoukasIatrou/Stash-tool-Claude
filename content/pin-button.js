// Injects the pin button on text selection.
// Never fails silently. Never hardcodes Claude DOM class names.
// Button is positioned at rect.right + 8 relative to the selection — never centred above it.

import { sendMessage } from '../shared/messaging.js';
import { showSidebar } from './sidebar-host.js';

let pinEl = null;
let savePopoverEl = null;
let currentSelection = null;

export function initPinButton(onSaveRequest) {
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('keyup', onKeyUp);
  document.addEventListener('mousedown', onMouseDown);
}

function onMouseUp(e) {
  // Small delay so the browser has time to finalise the selection.
  setTimeout(() => checkSelection(e), 10);
}

function onKeyUp() {
  setTimeout(() => checkSelection(), 10);
}

function onMouseDown(e) {
  if (pinEl && !pinEl.contains(e.target) && (!savePopoverEl || !savePopoverEl.contains(e.target))) {
    hidePin();
  }
}

function checkSelection() {
  const sel = window.getSelection();
  const text = sel?.toString().trim();

  if (!text) {
    hidePin();
    return;
  }

  currentSelection = { text, range: sel.getRangeAt(0).cloneRange() };
  const rect = sel.getRangeAt(0).getBoundingClientRect();

  if (!rect.width && !rect.height) {
    hidePin();
    return;
  }

  showPin(rect);
}

function showPin(rect) {
  if (!pinEl) {
    pinEl = document.createElement('button');
    pinEl.className = 'stash-pin-btn stash-pin-root';
    pinEl.title = 'Save to Stash';
    pinEl.textContent = '📌';
    pinEl.addEventListener('click', onPinClick);
    document.body.appendChild(pinEl);
  }

  // §non-negotiable: position at rect.right + 8, vertically centred on the selection.
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  pinEl.style.left = `${rect.right + scrollX + 8}px`;
  pinEl.style.top = `${rect.top + scrollY + rect.height / 2}px`;
  pinEl.style.display = 'flex';
}

function hidePin() {
  if (pinEl) pinEl.style.display = 'none';
  hidePopover();
  currentSelection = null;
}

async function onPinClick(e) {
  e.stopPropagation();
  if (!currentSelection) return;

  // On non-conversation pages (Projects list, homepage, etc.) skip folder
  // auto-creation and open the picker with no pre-selected folder.
  if (!isConversationPage()) {
    showSavePopover(currentSelection.text, { conversationFolderId: null }, null);
    return;
  }

  const convTitle   = detectConversationTitle() ?? 'Untitled';
  const projectName = detectProjectName();

  let ensureResult;
  try {
    ensureResult = await sendMessage({
      type: 'ENSURE_CONVERSATION_FOLDER',
      conversationTitle: convTitle,
      projectName,
      conversationId: location.pathname,
    });
  } catch (err) {
    console.error('[Stash] Failed to ensure conversation folder:', err);
    return;
  }

  showSavePopover(currentSelection.text, ensureResult, convTitle, projectName);
}

// ─── DOM detection — broad query, no hardcoded class names ───────────────────

// Generic page states that are NOT conversation titles.
const GENERIC_TITLES = new Set([
  'Claude', 'New chat', 'New Chat', 'Projects', 'Recents',
  'Starred', 'Home', '', 'Untitled',
]);

// Returns true only when the current URL is a Claude conversation page.
// Non-conversation pages (Projects list, homepage, etc.) should not trigger
// title detection or folder creation.
export function isConversationPage() {
  return /^\/chat\/[0-9a-f-]{8,}/i.test(location.pathname);
}

function sanitiseTitle(raw) {
  return raw
    .trim()
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectConversationTitle() {
  // document.title is the most reliable source: Claude's SPA router sets it to
  // exactly the conversation name, with no sidebar metadata mixed in.
  const pageTitle = sanitiseTitle((document.title ?? '').replace(/ - Claude$/i, ''));
  if (pageTitle && !GENERIC_TITLES.has(pageTitle)) return pageTitle;

  // Fallback: narrow DOM queries — skip the broad [data-testid*="conversation"]
  // selector because it also matches sidebar nav links whose textContent includes
  // metadata like "• 2 hours ago" that would corrupt the folder name.
  const candidates = [
    document.querySelector('h1'),
    document.querySelector('header h2'),
  ].filter(Boolean);

  for (const el of candidates) {
    const text = sanitiseTitle(el.textContent ?? '');
    if (text && !GENERIC_TITLES.has(text)) return text;
  }

  console.warn('[Stash] Could not detect a specific conversation title — page title:', document.title);
  return null;
}

function detectProjectName() {
  // Detect if we're inside a Claude project by looking for project indicators.
  // No hardcoded class names — query broadly and log.
  const candidates = [
    document.querySelector('[data-testid*="project"]'),
    document.querySelector('[aria-label*="project" i]'),
    document.querySelector('[href*="/project/"]'),
  ].filter(Boolean);

  console.log('[Stash] Project candidates found:', candidates.map((el) => ({
    tag: el.tagName,
    text: el.textContent?.trim().slice(0, 60),
    href: el.href,
  })));

  if (candidates.length === 0) return null;

  // Also check URL pattern.
  if (window.location.pathname.includes('/project/')) {
    const projectEl = candidates.find((el) => el.textContent?.trim());
    return projectEl?.textContent?.trim() ?? null;
  }

  return null;
}

// ─── Save popover — two-step: folder → list ───────────────────────────────────

function showSavePopover(text, { conversationFolderId }, convTitle) {
  hidePopover();

  // Capture range before anything clears the selection.
  const savedRange = currentSelection?.range ?? null;

  savePopoverEl = document.createElement('div');
  savePopoverEl.className = 'stash-save-popover stash-pin-root';
  document.body.appendChild(savePopoverEl);
  positionPopover();

  // ctx is shared across both steps via closure.
  const ctx = { savedRange, text, convTitle, conversationFolderId, allFolders: null };
  renderFolderStep(ctx);
}

async function renderFolderStep(ctx) {
  savePopoverEl.innerHTML = '';

  const stepTitle = popEl('p', 'stash-save-popover__step-title', 'Select folder');
  const loadingEl = popEl('p', 'stash-save-popover__loading', 'Loading…');
  savePopoverEl.append(stepTitle, loadingEl);

  try {
    const res = await sendMessage({ type: 'GET_FOLDERS' });
    ctx.allFolders = res.folders;
  } catch (err) {
    console.error('[Stash] Failed to load folders for picker:', err);
    loadingEl.textContent = 'Error loading folders.';
    return;
  }

  loadingEl.remove();

  // Show general, conversation and manual folders — all can hold lists directly.
  // Project folders are containers only; their lists live in child conversation folders.
  const listable = ctx.allFolders
    .filter((f) => f.type === 'general' || f.type === 'conversation' || f.type === 'manual')
    .sort((a, b) => {
      // Current conversation folder first.
      if (a.id === ctx.conversationFolderId) return -1;
      if (b.id === ctx.conversationFolderId) return 1;
      return 0;
    });

  if (!listable.length) {
    savePopoverEl.appendChild(popEl('p', 'stash-save-popover__loading', 'No folders found.'));
    return;
  }

  const scroll = popEl('div', 'stash-save-popover__scroll');
  listable.forEach((folder) => {
    const parent = ctx.allFolders.find((f) => f.id === folder.parentId);
    const label  = parent && parent.type !== 'general'
      ? `${parent.name} / ${folder.name}`
      : folder.name;

    const btn = popEl('button', 'stash-save-popover__folder-btn', label);
    if (folder.id === ctx.conversationFolderId) {
      btn.classList.add('stash-save-popover__folder-btn--current');
      btn.appendChild(popEl('span', 'stash-save-popover__current-tag', 'current'));
    }
    btn.addEventListener('click', () => renderListStep(ctx, folder.id));
    scroll.appendChild(btn);
  });
  savePopoverEl.appendChild(scroll);
}

async function renderListStep(ctx, folderId) {
  savePopoverEl.innerHTML = '';

  const back = popEl('button', 'stash-save-popover__back', '← Folders');
  back.addEventListener('click', () => renderFolderStep(ctx));

  const folder = ctx.allFolders?.find((f) => f.id === folderId);
  const stepTitle = popEl('p', 'stash-save-popover__step-title', folder?.name ?? 'Select list');
  const loadingEl = popEl('p', 'stash-save-popover__loading', 'Loading…');
  savePopoverEl.append(back, stepTitle, loadingEl);

  let lists;
  try {
    const res = await sendMessage({ type: 'GET_LISTS', folderId });
    lists = res.lists;
  } catch (err) {
    console.error('[Stash] Failed to load lists for picker:', err);
    loadingEl.textContent = 'Error loading lists.';
    return;
  }

  loadingEl.remove();

  const activeLists = lists
    .filter((l) => !l.isArchived)
    .sort((a, b) => a.displayOrder - b.displayOrder);

  if (!activeLists.length) {
    savePopoverEl.appendChild(popEl('p', 'stash-save-popover__loading', 'No lists in this folder.'));
    return;
  }

  const scroll = popEl('div', 'stash-save-popover__scroll');
  activeLists.forEach((list) => {
    const btn = popEl('button', 'stash-save-popover__list-btn');

    const dot = popEl('span', 'stash-save-popover__dot');
    dot.style.background = list.colour ?? '#6b7280';
    const name = popEl('span', '', list.name);
    btn.append(dot, name);

    btn.addEventListener('click', () =>
      saveHighlight(ctx.text, list.id, folderId, ctx.convTitle, ctx.savedRange, list.colour)
    );
    scroll.appendChild(btn);
  });
  savePopoverEl.appendChild(scroll);
}

// Small helper — avoids repeating document.createElement + className + textContent.
function popEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function positionPopover() {
  if (!pinEl || !savePopoverEl) return;
  const pinRect = pinEl.getBoundingClientRect();
  savePopoverEl.style.left = `${pinRect.right + window.scrollX + 8}px`;
  savePopoverEl.style.top = `${pinRect.top + window.scrollY}px`;
}

async function saveHighlight(text, listId, folderId, conversationTitle, range, colour) {
  try {
    const { id } = await sendMessage({
      type: 'SAVE_HIGHLIGHT',
      text,
      listId,
      folderId,
      conversationTitle,
      conversationUrl: isConversationPage() ? location.href : undefined,
    });
    console.log('[Stash] Highlight saved to list', listId, 'id:', id);
    if (range) applyHighlightMark(range, colour, id, listId, folderId);
    hidePin();
    showSidebar();
    window.dispatchEvent(new CustomEvent('stash:highlight-saved', { detail: { listId, folderId } }));
  } catch (err) {
    console.error('[Stash] Failed to save highlight:', err);
  }
}

function applyHighlightMark(range, colour, highlightId, listId, folderId) {
  const c = colour ?? '#7c3aed';

  function makeMark() {
    const mark = document.createElement('mark');
    mark.dataset.stashHighlight = '1';
    if (highlightId !== undefined) {
      mark.dataset.stashHighlightId = String(highlightId);
      _knownMarkIds.add(String(highlightId));
    }
    if (listId   !== undefined) mark.dataset.stashListId   = String(listId);
    if (folderId !== undefined) mark.dataset.stashFolderId = String(folderId);
    const s = mark.style;
    s.setProperty('background',    hexToRgba(c, 0.28), 'important');
    s.setProperty('border-bottom', `2px solid ${c}`,   'important');
    s.setProperty('padding-bottom','1px',               'important');
    s.setProperty('border-radius', '2px',               'important');
    s.setProperty('display',       'inline',            'important');
    s.setProperty('cursor',        'default',           'important');
    s.setProperty('color',         'inherit',           'important');
    return mark;
  }

  try {
    range.surroundContents(makeMark());
    return;
  } catch {}

  // surroundContents failed — range spans element boundaries (e.g. inline <code>
  // or <strong> inside prose). Wrap each text node individually so we never call
  // extractContents(), which physically moves DOM nodes and causes two bugs:
  //   1. The mark renders as a rectangle (block elements pulled inside it).
  //   2. Adjacent content like list-item markers ('22') gets displaced.
  const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) {
    if (range.intersectsNode(node)) textNodes.push(node);
  }

  if (!textNodes.length) {
    try {
      const m = makeMark();
      m.appendChild(range.extractContents());
      range.insertNode(m);
    } catch (err) {
      console.warn('[Stash] Could not apply highlight mark — selection spans element boundaries:', err.message);
    }
    return;
  }

  for (const tn of textNodes) {
    // Whitespace-only nodes (e.g. the bare \n between a code block and the next
    // paragraph) sit directly inside CSS grid containers. Wrapping them makes the
    // <mark> a grid item → full-column width → rectangle. Skip them.
    if (!tn.textContent.trim()) continue;

    const sub = document.createRange();
    const start = tn === range.startContainer ? range.startOffset : 0;
    const end   = tn === range.endContainer   ? range.endOffset   : tn.textContent.length;
    sub.setStart(tn, start);
    sub.setEnd(tn, end);
    try {
      sub.surroundContents(makeMark());
    } catch (err) {
      console.warn('[Stash] sub-range wrap failed:', err.message);
    }
  }
}

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ─── Highlight restore on page load ──────────────────────────────────────────

let _isRestoring   = false;
let _restorePending = false; // restore was requested while one was already running
let _obsTimer      = null;
let _obsActive     = false;
let _hasScrolledToHighlight = false;
const _knownMarkIds = new Set();

export function forgetMarkId(id) {
  _knownMarkIds.delete(String(id));
}

export function initHighlightRestore() {
  startObserver();
  // Multiple passes — Claude's SPA renders content progressively, so later passes
  // catch text that wasn't in the DOM yet during earlier passes.
  addRestorePass(2000);
  addRestorePass(5000);
  addRestorePass(10000);
  addRestorePass(20000);
  addRestorePass(30000);
  addRestorePass(60000);

  // SPA navigation — URL changes without a page reload.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      stopObserver();
      startObserver();
      addRestorePass(2000);
      addRestorePass(5000);
      addRestorePass(10000);
    }
  }, 1000);
}

// Schedules an additional restore pass without cancelling any pending pass.
// Called externally after cross-page navigation to trigger extra retries.
export function addRestorePass(delayMs) {
  setTimeout(doRestore, delayMs);
}

function startObserver() {
  if (_obsActive) return;
  _obsActive = true;
  const obs = new MutationObserver((mutations) => {
    // Ignore mutations caused by our own <mark> insertions; any other added node
    // means external content changed (Claude re-rendered) — schedule a re-restore.
    const hasExternal = mutations.some((m) =>
      Array.from(m.addedNodes).some(
        (n) => !(n.nodeType === Node.ELEMENT_NODE && n.dataset?.stashHighlight === '1')
      )
    );
    if (!hasExternal) return;
    clearTimeout(_obsTimer);
    const missingMark = _knownMarkIds.size > 0 &&
      [..._knownMarkIds].some(
        (id) => !document.querySelector(`[data-stash-highlight-id="${id}"]`)
      );
    _obsTimer = setTimeout(doRestore, missingMark ? 50 : 200);
  });
  obs.observe(document.body, { childList: true, subtree: true });
  _mutationObserverHandle = obs;
}

function stopObserver() {
  _obsActive = false;
  _mutationObserverHandle?.disconnect();
  _mutationObserverHandle = null;
  clearTimeout(_obsTimer);
  _hasScrolledToHighlight = false;
}

let _mutationObserverHandle = null;

async function doRestore() {
  if (_isRestoring) {
    // Another restore is already running. Flag it so the active restore triggers
    // one more pass when it finishes — this catches Claude re-renders that happen
    // while the observer is watching but _isRestoring blocks a concurrent run.
    _restorePending = true;
    return;
  }
  _isRestoring = true;
  let applied = 0;
  try {
    applied = await restoreHighlightsForCurrentPage();
  } finally {
    _isRestoring = false;
    if (_restorePending) {
      _restorePending = false;
      setTimeout(doRestore, 300);
    } else if (applied > 0) {
      // We just inserted marks — Claude's renderer may immediately re-render and
      // remove them. Run follow-up passes to catch that window.
      setTimeout(doRestore, 600);
      setTimeout(doRestore, 2000);
      setTimeout(doRestore, 5000);
    }
  }
}

// Returns the number of marks successfully applied this pass.
async function restoreHighlightsForCurrentPage() {
  if (!isConversationPage()) {
    console.log('[Stash] Restore: not a conversation page, skipping');
    return 0;
  }

  // Detect title for the name-based fallback lookup.
  // Do NOT bail early if null — conversationId (URL path) lookup works without a title.
  const convTitle = detectConversationTitle();
  const currentPath = location.pathname;

  // IMPORTANT: use GET_FOLDERS + find — never ENSURE_CONVERSATION_FOLDER here.
  // ENSURE creates folders as a side effect; calling it during restore would
  // create empty folders for every transient page state during loading.
  let folderId;
  try {
    const { folders } = await sendMessage({ type: 'GET_FOLDERS' });
    // Prefer conversationId match (path-based, always reliable). Fall back to name
    // match for folders created before conversationId tracking was added.
    const folder =
      folders.find((f) => f.type === 'conversation' && f.conversationId === currentPath) ??
      folders.find((f) => f.type === 'conversation' && convTitle && f.name === convTitle);
    if (!folder) {
      console.log('[Stash] Restore: no saved folder for', convTitle ?? currentPath);
      return 0;
    }
    folderId = folder.id;
  } catch (err) {
    console.error('[Stash] Restore: failed to load folders:', err);
    return 0;
  }

  let lists;
  try {
    lists = (await sendMessage({ type: 'GET_LISTS', folderId })).lists;
  } catch (err) {
    console.error('[Stash] Restore: failed to load lists:', err);
    return 0;
  }

  // Preserve scroll position — window.find() scrolls the page to each match.
  const savedScrollY = window.scrollY;

  // Restrict text search to <main> to exclude nav sidebar previews of conversations.
  const searchRoot = document.querySelector('main') ?? document.body;

  let found = 0, missed = 0;
  for (const list of lists) {
    let highlights;
    try {
      highlights = (await sendMessage({ type: 'GET_HIGHLIGHTS', listId: list.id })).highlights;
    } catch (err) {
      console.error('[Stash] Restore: failed to load highlights for list', list.id, err);
      continue;
    }
    for (const h of highlights) {
      const existing = document.querySelector(`[data-stash-highlight-id="${h.id}"]`);
      if (existing) {
        // Only skip if mark is inside the content area AND actually visible.
        // If it landed in the nav sidebar or a hidden buffer, unwrap and re-apply.
        if (searchRoot.contains(existing) && existing.offsetParent !== null) continue;
        const par = existing.parentNode;
        if (par) {
          while (existing.firstChild) par.insertBefore(existing.firstChild, existing);
          par.removeChild(existing);
          par.normalize();
          _knownMarkIds.delete(String(h.id));
        }
      }
      const range = findTextRange(h.text, searchRoot);
      if (range) {
        applyHighlightMark(range, list.colour, h.id, h.listId, h.folderId);
        found++;
      } else {
        missed++;
        console.log('[Stash] Restore: not found in DOM:', h.text.slice(0, 60));
      }
    }
  }

  window.scrollTo({ top: savedScrollY, behavior: 'instant' });
  console.log(`[Stash] Restore pass: ${found} applied, ${missed} not in DOM yet`);

  return found;
}

// Walks all visible text nodes in the document to find searchText, then returns
// a Range that precisely spans it. Unlike window.find(), this has no cursor
// state between calls and is not affected by Claude's re-renders or by
// whether the match is near the viewport.
function findTextRange(searchText, root = document.body) {
  if (!searchText) return null;

  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        // Skip non-rendered content.
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
        // Skip screen-reader-only and aria-hidden containers — their text is
        // invisible to the user and the same content appears in the visible DOM.
        if (parent.closest('[aria-hidden="true"], [class~="sr-only"]')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  // Concatenate all visible text nodes into one string, tracking each segment's
  // position so we can map a match offset back to a specific text node.
  let combined = '';
  const segments = []; // { node, start }
  let node;
  while ((node = walker.nextNode())) {
    const t = node.textContent;
    if (!t) continue;
    segments.push({ node, start: combined.length });
    combined += t;
  }

  function normalise(s) {
    return s
      .toLowerCase()
      .replace(/[‘’‚‛′‵]/g, "'")
      .replace(/[“”„‟″‶]/g, '"')
      .replace(/[–—―]/g, '-')
      .replace(/-{2,}/g, '-')   // collapse --- so it matches a single em-dash in the DOM
      .replace(/ /g, ' ');
  }

  const needle = normalise(searchText);
  const haystack = normalise(combined);
  const idx = haystack.indexOf(needle);
  if (idx === -1) return null;

  const endIdx = idx + needle.length;

  // Locate which text node(s) contain the start and end of the match.
  let startSeg = null, endSeg = null;
  for (const seg of segments) {
    const segEnd = seg.start + seg.node.textContent.length;
    if (!startSeg && seg.start <= idx && idx < segEnd) startSeg = seg;
    if (seg.start < endIdx && endIdx <= segEnd) { endSeg = seg; break; }
  }
  if (!startSeg || !endSeg) return null;

  try {
    const range = document.createRange();
    range.setStart(startSeg.node, idx - startSeg.start);
    range.setEnd(endSeg.node, endIdx - endSeg.start);
    return range;
  } catch (err) {
    console.warn('[Stash] findTextRange: could not create range:', err.message);
    return null;
  }
}

function hidePopover() {
  if (savePopoverEl) {
    savePopoverEl.remove();
    savePopoverEl = null;
  }
}
