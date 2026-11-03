/* NiceC0re page: replaces the static desktop screenshot with a gallery of the
 * latest CI boot test (frames + result.json from the iso repo's seq/ folder),
 * a status table and a clickable timeline. If anything fails to load, the
 * original screenshot stays. */
(function () {
  var RAW = '';
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c];
    });
  }
  var CSS =
    '.bg{margin-top:2.5rem;border:1px solid var(--border);border-radius:.75rem;overflow:hidden;background:var(--card)}' +
    '.bg-screen{position:relative;background:#000;aspect-ratio:16/10}' +
    '.bg-screen img{display:block;width:100%;height:100%;object-fit:contain}' +
    '.bg-bar{display:flex;align-items:center;gap:.5rem;padding:.6rem .8rem;border-top:1px solid var(--border);font-size:.8rem}' +
    '.bg-bar .bg-cap{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted-foreground)}' +
    '.bg-btn{border:1px solid var(--border);background:transparent;color:inherit;border-radius:.4rem;width:2rem;height:2rem;cursor:pointer;font-size:.95rem;line-height:1}' +
    '.bg-btn:hover{background:var(--muted)}' +
    '.bg-badge{position:absolute;top:.6rem;left:.6rem;padding:.2rem .6rem;border-radius:999px;font-size:.75rem;font-weight:600;color:#fff;background:#16a34a}' +
    '.bg-badge.bad{background:var(--destructive)}' +
    '.bg-tl{padding:.9rem 1rem 1.1rem;border-top:1px solid var(--border)}' +
    '.bg-time{display:flex;align-items:baseline;gap:.5rem;font-size:.78rem;color:var(--muted-foreground);margin-bottom:.55rem;font-variant-numeric:tabular-nums}' +
    '.bg-time b{color:inherit;font-weight:600}' +
    '.bg-time .bg-chap{margin-left:auto;font-weight:600;color:inherit;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.bg-sb{position:relative;display:flex;height:1.1rem;align-items:center;cursor:pointer;touch-action:none;outline:none;-webkit-tap-highlight-color:transparent}' +
    '.bg-seg{position:relative;flex:1 1 0;height:5px;margin-right:2px;border-radius:3px;background:var(--border);overflow:hidden;transition:height .12s}' +
    '.bg-seg:last-of-type{margin-right:0}' +
    '.bg-sb:hover .bg-seg,.bg-sb.drag .bg-seg,.bg-sb:focus-visible .bg-seg{height:9px}' +
    '.bg-fill{position:absolute;left:0;top:0;bottom:0;width:0;background:linear-gradient(90deg,#16a34a,#4ade80)}' +
    '.bg-seg.bad .bg-fill{background:linear-gradient(90deg,var(--destructive),#fb7185)}' +
    '.bg-seg.hov:not(.bad){background:color-mix(in oklab,var(--border) 60%,var(--foreground) 12%)}' +
    '.bg-knob{position:absolute;top:50%;left:0;width:.95rem;height:.95rem;margin:-.475rem 0 0 -.475rem;border-radius:50%;background:#fff;border:2px solid #16a34a;box-shadow:0 1px 4px rgba(0,0,0,.35);transform:scale(0);transition:transform .12s;pointer-events:none}' +
    '.bg-sb:hover .bg-knob,.bg-sb.drag .bg-knob,.bg-sb:focus-visible .bg-knob{transform:scale(1)}' +
    '.bg-tip{position:absolute;bottom:1.6rem;left:0;width:176px;transform:translateX(-50%);background:var(--card);border:1px solid var(--border);border-radius:.5rem;box-shadow:0 6px 22px rgba(0,0,0,.28);overflow:hidden;pointer-events:none;opacity:0;transition:opacity .1s;z-index:3}' +
    '.bg-sb:hover .bg-tip,.bg-sb.drag .bg-tip{opacity:1}' +
    '.bg-tip img{display:block;width:100%;aspect-ratio:16/10;object-fit:cover;background:#000}' +
    '.bg-tip span{display:block;padding:.3rem .5rem;font-size:.7rem;line-height:1.25;text-align:center}' +
    '.bg-tip span b{display:block;font-size:.75rem}' +
    '.bg-chaps{display:flex;margin-top:.3rem}' +
    '.bg-chaps span{flex:1 1 0;margin-right:2px;min-width:0;font-size:.64rem;color:var(--muted-foreground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.bg-chaps span.cur{color:inherit;font-weight:600}' +
    '.bg-st{width:100%;font-size:.85rem;border-top:1px solid var(--border);border-collapse:collapse}' +
    '.bg-st td{padding:.5rem .8rem;border-bottom:1px solid var(--border)}' +
    '.bg-st tr:last-child td{border-bottom:0}' +
    '.bg-st td:last-child{text-align:right;font-weight:600}' +
    '.bg-ok{color:#16a34a}.bg-no{color:var(--destructive)}';

  // Each build page reads its own test results: Arch (NiceC0re) and Debian (Goldwing).
  function pageConfig() {
    var p = location.pathname;
    if (p.indexOf('nicecore') >= 0) {
      return {
        raw: 'https://raw.githubusercontent.com/pearOS-archlinux/iso/main/seq/',
        host: function () {
          var img = document.querySelector('img[src$="pearos-desktop.webp"]');
          return img ? img.parentElement : null;
        }
      };
    }
    if (p.indexOf('/debian') >= 0) {
      return {
        raw: 'https://raw.githubusercontent.com/Pear-Project/iso/main/seq/',
        host: function () {
          var t = document.querySelector('tbody[id$="-versions-table"]');
          var sec = t && t.closest('section');
          if (!sec) return null;
          var holder = document.createElement('div');
          holder.className = 'container max-w-4xl bg-holder';
          holder.style.display = 'none';
          sec.parentNode.insertBefore(holder, sec);
          return holder;
        }
      };
    }
    return null;
  }

  function init() {
    var cfg = pageConfig();
    if (!cfg) return;
    RAW = cfg.raw;
    // Fetch first, so a page without results is left exactly as it was.
    fetch(RAW + 'result.json', {cache: 'no-cache'}).then(function (r) { return r.json(); }).then(function (res) {
      var host = cfg.host();
      if (host) build(host, res);
    }).catch(function () {});
  }

  function build(host, res) {
    var n = res.frames | 0;
    if (!n) return;
    var iv = res.interval || 10;
    var notes = res.notes || {};
    var failStage = res.failure && res.failure.stage;
    function label(i) {
      if (notes[i]) return notes[i];
      if (i === 1) return 'Booting the live ISO';
      if (res.desktop_frame && i < res.desktop_frame) return 'Booting';
      if (i === n && res.installer) return 'Calamares';
      return 'Boot test';
    }
    var style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);

    var ok = !!res.passed;
    var built = res.built ? new Date(res.built).toISOString().slice(0, 10) : '';
    function row(name, good, yes, no) {
      return '<tr><td>' + name + '</td><td class="' + (good ? 'bg-ok' : 'bg-no') + '">' + (good ? yes : no) + '</td></tr>';
    }
    var uiRow = res.ui
      ? row('UI sanity (menu bar + dock)', res.ui.ok, 'OK · ' + res.ui.top.toFixed(0) + '% / ' + res.ui.dock.toFixed(0) + '%', 'Differs · ' + res.ui.top.toFixed(0) + '% / ' + res.ui.dock.toFixed(0) + '%')
      : '<tr><td>UI sanity</td><td>not run</td></tr>';
    var sc = res.score || null;
    function scoreRow(name, v) {
      if (v === null || v === undefined) return '';
      return '<tr><td>' + name + '</td><td class="' + (v >= 100 ? 'bg-ok' : (v >= 50 ? '' : 'bg-no')) + '">' + v + ' / 100</td></tr>';
    }
    var scoreHtml = sc
      ? '<table class="bg-st"><tr><td><strong>Success score</strong></td><td class="' + (sc.total >= 90 ? 'bg-ok' : (sc.total >= 60 ? '' : 'bg-no')) + '" style="font-size:1.1rem">' + sc.total + ' / 100</td></tr>' +
        scoreRow('Boot test', sc.boot) + scoreRow('UI sanity', sc.ui) + scoreRow('Installable', sc.install) + scoreRow('Usability', sc.usability) + '</table>'
      : '';
    var checks = (sc && sc.checks) || {};
    var checksHtml = Object.keys(checks).length
      ? '<table class="bg-st">' + Object.keys(checks).map(function (k) {
          var c = checks[k];
          return '<tr><td>' + esc(k) + '</td><td class="' + (c.ok ? 'bg-ok' : 'bg-no') + '">' + (c.ok ? 'OK' : 'Failed') + (c.detail ? ' <span style="font-weight:400;font-size:.75rem">· ' + esc(c.detail) + '</span>' : '') + '</td></tr>';
        }).join('') + '</table>'
      : '';
    var statusHtml = scoreHtml + '<table class="bg-st">' +
      row('Boot', res.booted, 'OK', 'Failed') + uiRow +
      row('Installer', res.installer, 'Opens', 'Does not open') +
      (res.install
        ? row('Installation (end to end)', res.install.finished && res.install.booted, 'Installs and boots' + (res.install.minutes ? ' · ' + Math.round(res.install.minutes) + ' min' : ''), 'Fails')
        : row('Installation', res.installer && ok, 'Possible', 'Not possible')) +
      '<tr><td>Last build</td><td>' + esc(res.iso || '') + (built ? ' · ' + built : '') + '</td></tr></table>' + checksHtml +
      (ok ? '' : '<p class="bg-no" style="padding:.6rem .8rem;font-size:.8rem;border-top:1px solid var(--border)">' +
        esc((res.failure && res.failure.reason) || res.verdict || 'Test failed').replace(/\*\*/g, '') + '</p>');

    var el = document.createElement('div');
    el.className = 'bg';
    el.innerHTML =
      '<div class="bg-screen"><img alt="pearOS NiceC0re boot test"><span class="bg-badge' + (ok ? '' : ' bad') + '">' +
      (ok ? 'Latest build: passing' : 'Latest build: failing') + '</span></div>' +
      '<div class="bg-bar"><button class="bg-btn" data-a="play" title="Pause / play" aria-label="Pause or play"></button>' +
      '<span class="bg-cap"></span><button class="bg-btn" data-a="save" title="Save this screenshot" aria-label="Save screenshot">⬇</button></div>' +
      '<div class="bg-tl"><div class="bg-time"><b class="bg-t-cur">0:00</b> / <span class="bg-t-tot"></span><span class="bg-chap"></span></div>' +
      '<div class="bg-sb" tabindex="0" role="slider" aria-label="Boot test timeline"><span class="bg-knob"></span>' +
      '<div class="bg-tip"><img alt=""><span></span></div></div><div class="bg-chaps"></div></div>' + statusHtml;
    if (host.classList.contains('bg-holder')) { host.style.display = ''; host.appendChild(el); } else host.replaceWith(el);

    var shot = el.querySelector('.bg-screen img'), cap = el.querySelector('.bg-cap');
    var playBtn = el.querySelector('[data-a=play]');
    var sb = el.querySelector('.bg-sb'), knob = el.querySelector('.bg-knob'), tip = el.querySelector('.bg-tip');
    var tipImg = tip.querySelector('img'), tipTxt = tip.querySelector('span');
    var tCur = el.querySelector('.bg-t-cur'), tTot = el.querySelector('.bg-t-tot'), chapEl = el.querySelector('.bg-chap');
    var chapsRow = el.querySelector('.bg-chaps');
    var cur = 1, timer = null, playing = true;

    // Chapters (like YouTube): consecutive frames of the same phase of the test.
    function chapterOf(note) {
      if (!note) return null;
      if (/^First boot|^Login|^Logging in|^Installed system/.test(note)) return 'First boot';
      if (/^Calamares: (installing|installation finished)/.test(note)) return 'Installing';
      if (/^Calamares/.test(note)) return 'Installer';
      if (/^Konsole/.test(note)) return 'Terminal';
      if (/^After the update/.test(note)) return 'After update';
      if (/^App:/.test(note)) return 'Apps';
      if (/desktop ready|installer loading|Language screen|Recovery screen/.test(note)) return 'Welcome app';
      return null;
    }
    var chapOf = [], segs = [], prevC = 'Boot';
    for (var i = 1; i <= n; i++) {
      var cn = chapterOf(notes[i]) || prevC;
      chapOf[i] = cn; prevC = cn;
      if (!segs.length || segs[segs.length - 1].name !== cn) segs.push({name: cn, start: i, count: 0, fill: null, lab: null, el: null});
      segs[segs.length - 1].count++;
    }
    segs.forEach(function (sg, k) {
      var d = document.createElement('div');
      d.className = 'bg-seg' + (!ok && k === segs.length - 1 ? ' bad' : '');
      d.style.flexGrow = sg.count;
      d.innerHTML = '<i class="bg-fill"></i>';
      sb.insertBefore(d, knob);
      sg.el = d; sg.fill = d.firstChild;
      var l = document.createElement('span');
      l.style.flexGrow = sg.count; l.textContent = sg.name;
      chapsRow.appendChild(l); sg.lab = l;
    });
    function fmt(sec) { return Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2); }
    tTot.textContent = fmt(n);
    function frameAt(clientX) {
      var r = sb.getBoundingClientRect();
      var f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      return Math.min(n, Math.floor(f * n) + 1);
    }
    function update() {
      var frac = cur / n;
      segs.forEach(function (sg) {
        var a0 = (sg.start - 1) / n, a1 = (sg.start - 1 + sg.count) / n;
        sg.fill.style.width = Math.min(1, Math.max(0, (frac - a0) / (a1 - a0))) * 100 + '%';
        sg.lab.classList.toggle('cur', cur >= sg.start && cur < sg.start + sg.count);
      });
      var w = sb.clientWidth;
      knob.style.left = Math.max(0, Math.min(1, (cur - 0.5) / n)) * w + 'px';
      tCur.textContent = fmt(cur);
      chapEl.textContent = chapOf[cur];
      sb.setAttribute('aria-valuenow', cur); sb.setAttribute('aria-valuemin', 1); sb.setAttribute('aria-valuemax', n);
      sb.setAttribute('aria-valuetext', fmt(cur) + ' · ' + chapOf[cur] + ' · ' + label(cur));
    }
    function showTip(clientX) {
      var f = frameAt(clientX), r = sb.getBoundingClientRect();
      var x = Math.min(r.width - 88, Math.max(88, clientX - r.left));
      tip.style.left = x + 'px';
      tipImg.src = RAW + 'web/' + f + '.webp';
      tipTxt.innerHTML = '<b>' + fmt(f) + ' · ' + esc(chapOf[f]) + '</b>' + esc(label(f));
      segs.forEach(function (sg) { sg.el.classList.toggle('hov', f >= sg.start && f < sg.start + sg.count); });
    }
    var dragging = false, resume = false;
    sb.addEventListener('pointermove', function (e) { showTip(e.clientX); if (dragging) show(frameAt(e.clientX)); });
    sb.addEventListener('pointerleave', function () { segs.forEach(function (sg) { sg.el.classList.remove('hov'); }); });
    sb.addEventListener('pointerdown', function (e) {
      dragging = true; resume = playing; pause();
      sb.classList.add('drag'); try { sb.setPointerCapture(e.pointerId); } catch (x) {}
      show(frameAt(e.clientX)); showTip(e.clientX);
    });
    function endDrag() {
      if (!dragging) return;
      dragging = false; sb.classList.remove('drag');
      if (resume && cur < n) play();
    }
    sb.addEventListener('pointerup', endDrag);
    sb.addEventListener('pointercancel', endDrag);
    sb.addEventListener('keydown', function (e) {
      var k = e.key;
      if (k === 'ArrowRight') { pause(); show(Math.min(n, cur + 1)); }
      else if (k === 'ArrowLeft') { pause(); show(Math.max(1, cur - 1)); }
      else if (k === 'Home') { pause(); show(1); }
      else if (k === 'End') { pause(); show(n); }
      else if (k === ' ' || k === 'Enter') { playing ? pause() : play(); }
      else return;
      e.preventDefault();
    });
    window.addEventListener('resize', update);
    function show(i) {
      cur = i;
      shot.src = RAW + 'web/' + i + '.webp';
      cap.textContent = chapOf[i] + ' — ' + label(i);
      update();
      if (n > i) new Image().src = RAW + 'web/' + (i + 1) + '.webp';
    }
    function setIcon() { playBtn.textContent = playing ? '⏸' : (cur >= n ? '↻' : '▶'); }
    function tick() {
      if (cur >= n) { playing = false; clearInterval(timer); setIcon(); return; }
      show(cur + 1);
    }
    function play() {
      if (cur >= n) show(1);
      playing = true; clearInterval(timer); timer = setInterval(tick, 1000); setIcon();
    }
    function pause() { playing = false; clearInterval(timer); setIcon(); }
    playBtn.onclick = function () { playing ? pause() : play(); };
    el.querySelector('[data-a=save]').onclick = function () {
      var name = 'pearos-boot-' + cur + '.png', url = RAW + cur + '.png';
      fetch(url).then(function (r) { return r.blob(); }).then(function (b) {
        var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
      }).catch(function () { window.open(url, '_blank'); });
    };
    shot.onerror = function () { /* keep whatever is shown */ };
    show(1); play();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
