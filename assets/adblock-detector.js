// Ad-blocker detection, layered:
// 1. Real network requests to known third-party ad domains (googlesyndication,
//    doubleclick).
// 2. Same-origin requests to files literally named ads.js / advertisement.js.
//    Filter lists block these generic *path* patterns regardless of domain —
//    unlike #1, there's no well-known "redirect to an empty 200 stub" evasion
//    for our own arbitrary filenames, which is why some blockers slip past #1.
// 3. The classic cosmetic "bait div", for blockers that only do element hiding.
// Any one signal firing shows the wall. Checks run for ~700ms before giving up,
// since some blockers take a moment to intercept.
//
// Loaded on every page except /donate/ and (on the download page) it would
// undercut the exact action we want visitors to complete.
(function () {
  var detected = false;
  var dismissed = false;
  var guardObserver = null;
  var guardInterval = null;
  var DISMISS_KEY = 'nc-adblock-dismissed';

  // Someone already hit "Ignore" this session -- don't even run the checks.
  try {
    if (sessionStorage.getItem(DISMISS_KEY) === '1') return;
  } catch (e) { /* storage disabled: just run the checks every time */ }

  // Resolved off a per-page NC_ASSETS_PREFIX (the same "../" depth each page
  // already uses for its own CSS/asset links) rather than <script src> --
  // this runs inline now (see below), so there's no script tag to read a src
  // from. Still works whether the site is deployed at a domain root or a
  // subfolder (e.g. a local /newpearos/ dev copy).
  var PREFIX = (typeof NC_ASSETS_PREFIX === 'string') ? NC_ASSETS_PREFIX : '';
  var SITE_ROOT = new URL(PREFIX, document.baseURI).href;
  var ASSETS_BASE = new URL(PREFIX + 'assets/', document.baseURI).href;

  // The wall's own critical display/position rules are set as an INLINE
  // style on the element itself (not just in the <style> tag below), so
  // deleting the <style> tag alone can't make it invisible. A MutationObserver
  // + a low-frequency poll re-mount the whole thing instantly if a user opens
  // DevTools and deletes the node ("Inspect element > Delete") — the standard
  // easy bypass for a wall that's just a plain DOM node with no guard.
  var WALL_CSS_TEXT = 'position:fixed !important;inset:0 !important;z-index:2147483647 !important;' +
    'display:flex !important;align-items:center !important;justify-content:center !important;' +
    'padding:22px !important;background:rgba(0,0,0,.5) !important;';

  function buildWall() {
    var wall = document.createElement('div');
    wall.id = 'nc-adblock-wall';
    wall.style.cssText = WALL_CSS_TEXT;
    wall.innerHTML =
      '<div class="ab-card">' +
        '<button type="button" id="ab-ignore" class="ab-ignore">Ignore :(</button>' +
        '<div class="ab-icon">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"></path>' +
            '<line x1="12" y1="9" x2="12" y2="13"></line>' +
            '<line x1="12" y1="17" x2="12.01" y2="17"></line>' +
          '</svg>' +
        '</div>' +
        '<h2>Ad blocker detected</h2>' +
        '<p>pearOS NiceC0re relies on ad revenue to stay free and open source. Please disable your ad blocker for this site to keep supporting development.</p>' +
        '<div class="ab-actions">' +
          '<button type="button" id="ab-continue">I\'ve disabled it — Continue</button>' +
          '<a href="' + SITE_ROOT + 'donate/">Or support us directly</a>' +
        '</div>' +
      '</div>';
    return wall;
  }

  function buildStyle() {
    var style = document.createElement('style');
    style.id = 'nc-adblock-style';
    style.textContent =
      '#nc-adblock-wall{backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}' +
      '#nc-adblock-wall .ab-card{position:relative;max-width:420px;width:100%;text-align:center;' +
        'padding:32px 28px;border:1px solid var(--border);border-radius:calc(var(--radius) * 2);' +
        'background:var(--popover);box-shadow:0 20px 50px -20px rgba(0,0,0,.35);' +
        'font-family:var(--font-sans);color:var(--popover-foreground)}' +
      '#nc-adblock-wall .ab-ignore{position:absolute;top:12px;right:14px;font:inherit;' +
        'font-family:var(--font-sans);font-size:.75rem;font-weight:500;color:var(--muted-foreground);' +
        'background:none;border:0;cursor:pointer;padding:4px;line-height:1;transition:color .2s}' +
      '#nc-adblock-wall .ab-ignore:hover{color:var(--popover-foreground);text-decoration:underline}' +
      '#nc-adblock-wall .ab-icon{display:flex;align-items:center;justify-content:center;' +
        'width:52px;height:52px;margin:0 auto 16px;border-radius:50%;' +
        'background:color-mix(in srgb, var(--destructive) 14%, transparent);color:var(--destructive)}' +
      '#nc-adblock-wall .ab-icon svg{width:26px;height:26px}' +
      '#nc-adblock-wall h2{font-family:var(--font-display);font-size:1.35rem;font-weight:600;' +
        'letter-spacing:-.02em;margin:0 0 10px;color:var(--popover-foreground)}' +
      '#nc-adblock-wall p{font-size:.925rem;line-height:1.55;color:var(--muted-foreground);margin:0 0 22px}' +
      '#nc-adblock-wall .ab-actions{display:flex;flex-direction:column;align-items:center;gap:12px}' +
      '#nc-adblock-wall button{font:inherit;font-family:var(--font-sans);font-weight:600;font-size:.925rem;' +
        'color:var(--primary-foreground);background:var(--primary);border:0;border-radius:var(--radius);' +
        'height:44px;padding:0 26px;cursor:pointer;transition:opacity .2s,transform .1s}' +
      '#nc-adblock-wall button:hover{opacity:.9}' +
      '#nc-adblock-wall button:active{transform:scale(.98)}' +
      '#nc-adblock-wall a{font-size:.85rem;color:var(--muted-foreground);text-decoration:none}' +
      '#nc-adblock-wall a:hover{color:var(--popover-foreground);text-decoration:underline}';
    return style;
  }

  function mountWall() {
    if (!document.getElementById('nc-adblock-style')) {
      document.head.appendChild(buildStyle());
    }
    var existing = document.getElementById('nc-adblock-wall');
    if (existing) {
      // still there but maybe tampered with (style attribute edited instead
      // of the node deleted) — re-assert the critical inline rules
      existing.style.cssText = WALL_CSS_TEXT;
      return;
    }
    var wall = buildWall();
    document.body.appendChild(wall);
    document.getElementById('ab-continue').addEventListener('click', function () {
      location.reload();
    });
    document.getElementById('ab-ignore').addEventListener('click', dismissWall);
  }

  // "Ignore :(" -- let this one visitor through for the rest of the tab
  // session instead of nagging them on every page.
  function dismissWall() {
    dismissed = true;
    if (guardObserver) { guardObserver.disconnect(); guardObserver = null; }
    if (guardInterval) { clearInterval(guardInterval); guardInterval = null; }
    var wall = document.getElementById('nc-adblock-wall');
    if (wall) wall.remove();
    try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch (e) { /* storage disabled */ }
  }

  function guardWall() {
    guardObserver = new MutationObserver(function () {
      if (detected && !dismissed) mountWall();
    });
    guardObserver.observe(document.documentElement, { childList: true, subtree: true });
    // belt-and-suspenders poll in case the observer itself gets suspended
    // (e.g. paused at a breakpoint while the node is deleted)
    guardInterval = setInterval(function () { if (detected && !dismissed) mountWall(); }, 400);
  }

  function showWall() {
    if (dismissed) return;
    if (detected) { mountWall(); return; }
    detected = true;
    mountWall();
    guardWall();
  }

  // --- signal 1: real requests to domains every ad blocker's default
  // lists block at the network level ---
  var baitUrls = [
    'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
    'https://www.googletagservices.com/tag/js/gpt.js',
    'https://googleads.g.doubleclick.net/pagead/id'
  ];
  baitUrls.forEach(function (url) {
    fetch(url, { method: 'GET', mode: 'no-cors', cache: 'no-store' })
      .catch(function () { showWall(); });
  });
  // belt-and-suspenders: a real <script> tag pointing at the AdSense loader.
  // onerror fires when the network request itself is blocked (ERR_BLOCKED
  // BY_CLIENT), which is exactly what ad blockers do to this URL.
  var probe = document.createElement('script');
  probe.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?nc_probe=1';
  probe.async = true;
  probe.onerror = showWall;
  document.head.appendChild(probe);

  // --- signal 2: same-origin bait files named like generic ad scripts.
  // Resolved off ASSETS_BASE so this fires the same way regardless of page
  // depth or whether the site sits at a domain root or a subfolder. ---
  [ASSETS_BASE + 'ads.js', ASSETS_BASE + 'advertisement.js'].forEach(function (path) {
    fetch(path, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) showWall(); })
      .catch(function () { showWall(); });
    var s = document.createElement('script');
    s.src = path + '?nc_probe=' + Date.now();
    s.async = true;
    s.onerror = showWall;
    document.head.appendChild(s);
  });

  // --- signal 3: classic cosmetic bait div, for filter-list-only blockers ---
  function checkBait() {
    var bait = document.createElement('div');
    bait.id = 'ad-container';
    bait.className = 'adsbox ad ads advert advertisement banner-ad google-ad sponsorad ' +
      'pub_300x250 pub_300x250m pub_728x90 text-ad textAd text_ad text_ads text-ads text-ad-links';
    bait.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:300px;height:250px;';
    bait.innerHTML = '&nbsp;';
    document.body.appendChild(bait);

    function check() {
      var blocked = bait.offsetHeight === 0 || bait.offsetWidth === 0 ||
        bait.offsetParent === null ||
        window.getComputedStyle(bait).display === 'none' ||
        window.getComputedStyle(bait).visibility === 'hidden';
      if (blocked) { bait.remove(); showWall(); return true; }
      return false;
    }

    setTimeout(function () {
      if (!check()) setTimeout(function () { check(); bait.remove(); }, 500);
    }, 150);
  }

  function init() {
    checkBait();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
