// Creates the sidebar host element and mounts it into a Shadow DOM.
// The Shadow DOM scopes all sidebar CSS away from the host page.

const HOST_ID    = 'stash-sidebar-host';
const TOGGLE_ID  = 'stash-toggle-tab';

const SIDEBAR_WIDTH_DEFAULT = 320;
const SIDEBAR_WIDTH_MIN     = 200;
const SIDEBAR_WIDTH_MAX     = 600;
const STORAGE_KEY           = 'stash-sidebar-width';

let hostEl      = null;
let toggleTabEl = null;
let shadowRoot  = null;
let visible     = false;

let currentWidth    = SIDEBAR_WIDTH_DEFAULT;
let _dragStartX     = 0;
let _dragStartWidth = 0;

export async function initSidebarHost(renderFn) {
  if (document.getElementById(HOST_ID)) return;

  // Load saved width before applying host styles — prevents a visible resize flash.
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  currentWidth = stored[STORAGE_KEY] ?? SIDEBAR_WIDTH_DEFAULT;
  currentWidth = Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, currentWidth));

  hostEl = document.createElement('div');
  hostEl.id = HOST_ID;
  applyHostStyles(hostEl);

  // Stop mouse and keyboard events from bubbling out of the sidebar.
  // Claude's page has document-level listeners that steal focus / intercept
  // keystrokes whenever a click or keydown reaches the document root.
  hostEl.addEventListener('mousedown', (e) => e.stopPropagation());
  hostEl.addEventListener('keydown',   (e) => e.stopPropagation());
  hostEl.addEventListener('keyup',     (e) => e.stopPropagation());
  hostEl.addEventListener('keypress',  (e) => e.stopPropagation());

  shadowRoot = hostEl.attachShadow({ mode: 'open' });

  // Inject the sidebar stylesheet into the shadow root.
  const styleLink = document.createElement('link');
  styleLink.rel = 'stylesheet';
  styleLink.href = chrome.runtime.getURL('content/sidebar/sidebar.css');
  shadowRoot.appendChild(styleLink);

  // Mount the sidebar UI once the stylesheet loads.
  styleLink.addEventListener('load', () => {
    console.log('[Stash] sidebar.css loaded OK — rendering sidebar UI');
    renderFn(shadowRoot);
    // Appended after renderFn so it sits on top in DOM order.
    shadowRoot.appendChild(createResizeHandle());
  });
  styleLink.addEventListener('error', () => {
    console.error('[Stash] sidebar.css failed to load — check web_accessible_resources in manifest. URL was:', styleLink.href);
  });

  // Persistent toggle tab — always visible on the right edge, slides with sidebar.
  toggleTabEl = document.createElement('button');
  toggleTabEl.id = TOGGLE_ID;
  Object.assign(toggleTabEl.style, {
    position:      'fixed',
    top:           '50%',
    right:         '0',
    transform:     'translateY(-50%)',
    zIndex:        String(2147483647 - 1),
    padding:       '10px 5px',
    background:    '#7c3aed',
    color:         '#fff',
    border:        'none',
    borderRadius:  '6px 0 0 6px',
    cursor:        'pointer',
    fontSize:      '11px',
    fontWeight:    '600',
    fontFamily:    'system-ui, -apple-system, sans-serif',
    letterSpacing: '0.05em',
    writingMode:   'vertical-rl',
    textOrientation: 'mixed',
    boxShadow:     '-2px 0 8px rgba(0,0,0,0.18)',
    transition:    'right 0.22s ease',
    userSelect:    'none',
  });
  toggleTabEl.textContent = 'STASH';
  toggleTabEl.title = 'Toggle Stash sidebar';
  toggleTabEl.addEventListener('click', toggleSidebar);
  document.body.appendChild(toggleTabEl);

  document.body.appendChild(hostEl);

  const cs = window.getComputedStyle(hostEl);
  console.log('[Stash] Sidebar host mounted with Shadow DOM');
  console.log('[Stash] Host computed style:', {
    display:    cs.display,
    position:   cs.position,
    width:      cs.width,
    height:     cs.height,
    top:        cs.top,
    right:      cs.right,
    transform:  cs.transform,
    zIndex:     cs.zIndex,
    overflow:   cs.overflow,
    opacity:    cs.opacity,
    visibility: cs.visibility,
  });
  console.log('[Stash] Sidebar CSS URL:', styleLink.href);
}

export function toggleSidebar() {
  setVisible(!visible);
}

// Opens the sidebar if it is not already visible. Safe to call redundantly.
export function showSidebar() {
  setVisible(true);
}

export function getShadowRoot() {
  return shadowRoot;
}

export function getHostElement() {
  return hostEl;
}

function setVisible(next) {
  if (!hostEl) {
    console.error('[Stash] Sidebar not yet initialised');
    return;
  }
  visible = next;
  hostEl.style.transform          = visible ? 'translateX(0)' : 'translateX(100%)';
  document.body.style.marginRight = visible ? `${currentWidth}px` : '0';
  if (toggleTabEl) {
    toggleTabEl.style.right = visible ? `${currentWidth}px` : '0';
  }
  console.log(`[Stash] Sidebar ${visible ? 'shown' : 'hidden'} — transform:`, hostEl.style.transform);
}

function applyHostStyles(el) {
  Object.assign(el.style, {
    // display must be explicit — :host { all: initial } in sidebar.css resets
    // display to 'inline' (the CSS initial value), which ignores width/height.
    display:    'block',
    position:   'fixed',
    top:        '0',
    right:      '0',
    width:      `${currentWidth}px`,
    height:     '100vh',
    zIndex:     '2147483647',
    transform:  'translateX(100%)',
    transition: 'transform 0.22s ease',
    boxSizing:  'border-box',
    overflow:   'hidden',
  });
}

function applyWidth(width) {
  currentWidth = width;
  hostEl.style.width = `${width}px`;
  if (visible) {
    document.body.style.marginRight = `${width}px`;
  }
  if (toggleTabEl && visible) {
    toggleTabEl.style.right = `${width}px`;
  }
}

function createResizeHandle() {
  const handle = document.createElement('div');
  handle.id = 'stash-resize-handle';
  Object.assign(handle.style, {
    position: 'absolute',
    top:      '0',
    left:     '0',
    width:    '6px',
    height:   '100%',
    cursor:   'col-resize',
    zIndex:   '1',
  });
  handle.addEventListener('mousedown', onResizeStart);
  return handle;
}

function onResizeStart(e) {
  e.preventDefault();
  e.stopPropagation();

  _dragStartX     = e.clientX;
  _dragStartWidth = currentWidth;

  // Disable open/close transition during drag — prevents laggy animation.
  hostEl.style.transition = 'none';

  // Prevent text selection on the page during drag.
  document.body.style.userSelect = 'none';
  document.body.style.cursor     = 'col-resize';

  document.addEventListener('mousemove', onResizeDrag);
  document.addEventListener('mouseup',   onResizeEnd);
}

function onResizeDrag(e) {
  // Dragging left (decreasing clientX) = wider sidebar.
  const delta    = _dragStartX - e.clientX;
  const newWidth = Math.min(
    SIDEBAR_WIDTH_MAX,
    Math.max(SIDEBAR_WIDTH_MIN, _dragStartWidth + delta)
  );
  applyWidth(newWidth);
}

function onResizeEnd() {
  document.removeEventListener('mousemove', onResizeDrag);
  document.removeEventListener('mouseup',   onResizeEnd);

  // Restore open/close transition.
  hostEl.style.transition = 'transform 0.22s ease';

  // Restore normal page behaviour.
  document.body.style.userSelect = '';
  document.body.style.cursor     = '';

  // Persist final width — only written on mouseup, not on every drag event.
  chrome.storage.local.set({ [STORAGE_KEY]: currentWidth });
}
