/*
 * Phone adaptation for the DSH web shell, injected by the frp-tunnel relay.
 *
 * 1. Layout: sets html.dsh-m on narrow / touch-first screens (mobile.css does
 *    the rest) and adds a menu button + backdrop for the off-canvas sidebar.
 * 2. History: DSH keeps all navigation in memory (the URL never changes), so
 *    the browser/Android back button would leave the app. This records each UI
 *    step — session switch, sidebar drawer, dialog/menu, right panel — as a
 *    history entry and replays it on popstate, giving real back/forward.
 *
 * It only clicks DSH's own buttons (found by role/aria-label/data attributes),
 * so it never touches DSH internals. Opt out with localStorage dsh-m = "off".
 */
(() => {
  if (window.__DSH_MOBILE__) return;
  window.__DSH_MOBILE__ = true;

  const html = document.documentElement;
  const pref = (() => {
    try {
      return localStorage.getItem('dsh-m');
    } catch {
      return null;
    }
  })();

  const narrow = matchMedia('(max-width: 760px)');
  const coarse = matchMedia('(pointer: coarse)');
  const wantMobile = () =>
    pref === 'on' || (pref !== 'off' && (narrow.matches || (coarse.matches && Math.min(screen.width, screen.height) < 820)));

  // Let the layout reach under notches and resize with the soft keyboard.
  const viewport = document.querySelector('meta[name="viewport"]');
  if (viewport) {
    viewport.setAttribute(
      'content',
      'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content',
    );
  }

  const apply = () => html.classList.toggle('dsh-m', wantMobile());
  apply();
  narrow.addEventListener?.('change', apply);
  coarse.addEventListener?.('change', apply);
  addEventListener('resize', apply);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const mobile = () => html.classList.contains('dsh-m');
  const visible = (el) => !!el && el.getClientRects().length > 0;

  const RE_OPEN_SIDE = /(打开|展开|显示|open|expand|show).*(侧边栏|sidebar)/i;
  const RE_CLOSE_SIDE = /(收起|关闭|隐藏|折叠|close|collapse|hide).*(侧边栏|sidebar)/i;
  const RE_RIGHT = /(右侧|right)/i;
  const RE_CLOSE_RIGHT = /(收起|关闭|隐藏|close|collapse|hide).*(右侧边栏|right)/i;
  const RE_NEW = /(新建会话|新会话|new (session|chat))/i;

  // The shell frame is the one element carrying DSH's sidebar state attributes;
  // its children are [sidebar column, center column, ...].
  const frame = () =>
    $('#root [data-sidebar-collapsed][data-rightbar-collapsed]') ||
    $('#root [data-rightbar-collapsed]') ||
    $('#root [data-sidebar-collapsed]');
  const sidebar = () => frame()?.firstElementChild ?? undefined;

  /**
   * Tag shell elements with stable marker classes for mobile.css. Reruns on
   * every observed mutation in case React re-rendered them; writes only when a
   * marker is missing so it cannot feed the observer.
   */
  function tagShell() {
    const mark = (el, name) => {
      if (el && !el.classList.contains(name)) el.classList.add(name);
    };
    const f = frame();
    if (!f) return;
    mark(f, 'dsh-m-frame');
    const [side, center] = f.children;
    mark(side, 'dsh-m-side');
    mark(center, 'dsh-m-center');
    for (const header of $$('header[data-window-drag]', center ?? f)) mark(header, 'dsh-m-header');
  }
  const labelled = (root, re, exclude) =>
    root
      ? $$('button[aria-label]', root).find((b) => re.test(b.getAttribute('aria-label')) && !(exclude && exclude.test(b.getAttribute('aria-label'))))
      : undefined;

  // ---------------------------------------------------------------- UI probes

  const sideOpen = () => {
    const f = frame();
    return !!f && !f.hasAttribute('data-sidebar-collapsed');
  };
  const rightOpen = () => !!$('[data-sidebar-right-open]');
  const overlayOpen = () =>
    $$('[role="dialog"], [role="menu"], [role="listbox"], [data-trigger-menu]').some(
      (el) => visible(el) && el.getAttribute('aria-hidden') !== 'true' && !el.closest('.dsh-m-side'),
    );
  const sessionId = () => $('[data-conversation-session]')?.getAttribute('data-conversation-session') || '';
  const phase = () => $('[data-phase]')?.getAttribute('data-phase') || '';

  /** One history entry: which session is in front and which overlay is on top. */
  function snapshot() {
    const id = sessionId();
    return {
      s: id && phase() !== 'hero' ? id : id ? 'hero' : 'page',
      o: overlayOpen() ? 'dlg' : sideOpen() ? 'side' : rightOpen() ? 'right' : '',
    };
  }
  const same = (a, b) => !!a && !!b && a.s === b.s && a.o === b.o;

  // ----------------------------------------------------------------- actions

  let ghost = false;
  const syncClasses = () => {
    html.classList.toggle('dsh-m-side-open', sideOpen() && !ghost);
    html.classList.toggle('dsh-m-right-open', rightOpen());
  };

  async function openDrawer() {
    if (sideOpen()) return;
    labelled(sidebar(), RE_OPEN_SIDE, RE_RIGHT)?.click();
    for (let i = 0; i < 20 && !sideOpen(); i++) await sleep(25);
  }
  async function closeDrawer() {
    if (!sideOpen()) return;
    labelled(sidebar(), RE_CLOSE_SIDE, RE_RIGHT)?.click();
    for (let i = 0; i < 20 && sideOpen(); i++) await sleep(25);
  }
  function closeRight() {
    labelled(document, RE_CLOSE_RIGHT)?.click();
  }
  function escape() {
    const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document;
    for (const type of ['keydown', 'keyup']) {
      target.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true }));
    }
  }

  /** Bring a session to the front by clicking its sidebar row, opening the drawer off-screen if needed. */
  async function switchSession(target) {
    if (target === 'page') return true;
    const wasOpen = sideOpen();
    if (!wasOpen) {
      ghost = true;
      syncClasses();
      html.classList.add('dsh-m-instant');
      await openDrawer();
    }
    let done = false;
    try {
      if (target === 'hero') {
        const button = labelled(sidebar(), RE_NEW);
        button?.click();
        done = !!button;
      } else {
        let row;
        for (let i = 0; i < 40 && !row; i++) {
          row = $(`[data-row-key="session:${CSS.escape(target)}"]`);
          if (!row) await sleep(40);
        }
        row?.click();
        done = !!row;
      }
      for (let i = 0; i < 40 && done && sessionId() !== target && target !== 'hero'; i++) await sleep(40);
    } finally {
      if (!wasOpen) {
        await closeDrawer();
        ghost = false;
        syncClasses();
        setTimeout(() => html.classList.remove('dsh-m-instant'), 50);
      }
    }
    return done;
  }

  // ----------------------------------------------------------------- history

  const KEY = 'dsh-m-history';
  let entries = [];
  let index = 0;
  let applying = false;
  let ignorePops = 0;

  const save = () => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ entries, index }));
    } catch {}
  };

  function push(state) {
    entries = entries.slice(0, index + 1);
    entries.push(state);
    index = entries.length - 1;
    history.pushState({ ...(history.state || {}), dshm: index }, '');
    save();
  }
  function replace(state) {
    entries[index] = state;
    history.replaceState({ ...(history.state || {}), dshm: index }, '');
    save();
  }
  function silentBack() {
    if (index <= 0) return;
    ignorePops++;
    index--;
    history.back();
    save();
  }

  /** Record a user-driven UI change. */
  function record() {
    if (applying || !mobile()) return;
    const current = snapshot();
    const top = entries[index];
    if (!top) {
      entries = [current];
      index = 0;
      replace(current);
      return;
    }
    if (same(current, top)) return;
    // Picking a session inside the drawer: close it; the next pass records the result.
    if (current.o === 'side' && top.o === 'side' && current.s !== top.s) {
      closeDrawer();
      return;
    }
    if (current.o && current.o !== top.o && current.s === top.s) {
      push(current); // an overlay opened on top of the same page
    } else if (top.o && !current.o) {
      // The overlay was dismissed in-page (tap outside, item picked). Drop its
      // entry instead of leaving a back press that does nothing.
      if (same(current, entries[index - 1])) silentBack();
      else replace(current);
    } else if (current.s !== top.s && !current.o && !top.o) {
      push(current);
    } else {
      replace(current);
    }
  }

  async function restore(target) {
    applying = true;
    try {
      let now = snapshot();
      if (now.o === 'dlg' && target.o !== 'dlg') {
        escape();
        await sleep(120);
        if (overlayOpen()) document.body.click();
        await sleep(80);
      }
      if (sideOpen() && target.o !== 'side' && target.s === snapshot().s) await closeDrawer();
      if (rightOpen() && target.o !== 'right') closeRight();
      now = snapshot();
      if (target.s !== now.s) {
        const ok = await switchSession(target.s);
        if (!ok) toast('无法返回该会话');
      }
      if (target.o === 'side' && !sideOpen()) await openDrawer();
      await sleep(150);
      entries[index] = snapshot();
      save();
    } finally {
      applying = false;
    }
  }

  addEventListener('popstate', (event) => {
    const at = event.state?.dshm;
    if (ignorePops > 0) {
      ignorePops--;
      // Re-sync in case the silent step landed somewhere unexpected.
      if (typeof at === 'number' && entries[at]) index = at;
      save();
      return;
    }
    if (typeof at !== 'number' || !entries[at]) {
      // Fell below our first entry (login / token hops). Stay on the page.
      ignorePops++;
      history.forward();
      return;
    }
    index = at;
    save();
    restore(entries[at]);
  });

  /**
   * Native back hook for the Android app: returns true when the page took a
   * step back itself, false at the start of its history (the app then leaves).
   */
  window.__DSH_MOBILE_BACK__ = () => {
    if (!mobile() || applying) return !!applying;
    // An open overlay that was never recorded still closes first.
    const now = snapshot();
    if (now.o === 'dlg' || now.o === 'side' || now.o === 'right') {
      if (index > 0 && entries[index]?.o === now.o) {
        history.back();
        return true;
      }
      restore({ s: now.s, o: '' });
      return true;
    }
    if (index <= 0) return false;
    history.back();
    return true;
  };

  // ------------------------------------------------------------------- toast

  let toastEl;
  let toastTimer;
  function toast(text) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'dsh-m-toast';
      document.body.append(toastEl);
    }
    toastEl.textContent = text;
    toastEl.setAttribute('data-show', '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.removeAttribute('data-show'), 1800);
  }

  // -------------------------------------------------------------------- boot

  const MENU_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';

  function mountChrome() {
    if ($('.dsh-m-menu')) return;
    const menu = document.createElement('button');
    menu.type = 'button';
    menu.className = 'dsh-m-menu';
    menu.setAttribute('aria-label', '菜单');
    menu.innerHTML = MENU_ICON;
    menu.addEventListener('click', () => openDrawer());
    const backdrop = document.createElement('div');
    backdrop.className = 'dsh-m-backdrop';
    backdrop.addEventListener('click', () => closeDrawer());
    document.body.append(backdrop, menu);
  }

  /** Close the drawer once a tap in it changed what the main column shows. */
  function centerSignature() {
    const center = $('.dsh-m-center');
    return `${sessionId()}|${phase()}|${center?.firstElementChild?.className ?? ''}`;
  }
  document.addEventListener(
    'click',
    (event) => {
      if (!mobile() || !sideOpen() || ghost) return;
      if (!event.target.closest?.('.dsh-m-side')) return;
      const before = centerSignature();
      setTimeout(() => {
        if (sideOpen() && centerSignature() !== before) closeDrawer();
      }, 350);
    },
    true,
  );

  // Swipe the drawer left to close it.
  let swipe;
  document.addEventListener(
    'touchstart',
    (event) => {
      if (!mobile() || !sideOpen() || event.touches.length !== 1) return;
      if (!event.target.closest?.('.dsh-m-side')) return;
      swipe = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    },
    { passive: true },
  );
  document.addEventListener(
    'touchend',
    (event) => {
      if (!swipe) return;
      const touch = event.changedTouches[0];
      const dx = touch.clientX - swipe.x;
      const dy = Math.abs(touch.clientY - swipe.y);
      swipe = undefined;
      if (dx < -60 && dy < 50) closeDrawer();
    },
    { passive: true },
  );

  let pending = 0;
  // DSH focuses the composer after every session switch; on a phone that pops
  // the keyboard over half the screen. Only allow focus right after a tap.
  let lastTouch = 0;
  const COMPOSER = '[data-composer-input], [data-composer-card]';
  document.addEventListener(
    'touchstart',
    (event) => {
      if (event.target?.closest?.(COMPOSER)) lastTouch = Date.now();
    },
    { capture: true, passive: true },
  );
  document.addEventListener(
    'focusin',
    (event) => {
      if (!mobile() || !coarse.matches) return;
      const el = event.target;
      if (!el?.closest?.(COMPOSER)) return;
      if (Date.now() - lastTouch > 800) el.blur();
    },
    true,
  );
  const observer = new MutationObserver(() => {
    tagShell();
    syncClasses();
    clearTimeout(pending);
    pending = setTimeout(record, 160);
  });

  async function boot() {
    for (let i = 0; i < 200 && !frame(); i++) await sleep(50);
    tagShell();
    mountChrome();
    // A persisted "sidebar open" would cover the whole phone screen on load.
    if (mobile() && sideOpen()) {
      html.classList.add('dsh-m-instant');
      await closeDrawer();
      setTimeout(() => html.classList.remove('dsh-m-instant'), 50);
    }
    syncClasses();
    try {
      const stored = JSON.parse(sessionStorage.getItem(KEY) || 'null');
      const at = history.state?.dshm;
      if (stored && typeof at === 'number' && stored.entries?.[at]) {
        entries = stored.entries;
        index = at;
      }
    } catch {}
    if (!entries.length) {
      entries = [snapshot()];
      index = 0;
      replace(entries[0]);
    }
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        'data-sidebar-collapsed',
        'data-sidebar-right-open',
        'data-conversation-session',
        'data-phase',
        'aria-hidden',
        'role',
      ],
    });
    record();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();

  window.__DSH_MOBILE_DEBUG__ = () => ({ entries, index, now: snapshot(), mobile: mobile() });
})();
