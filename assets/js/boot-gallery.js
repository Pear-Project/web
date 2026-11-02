/* NiceC0re page: replaces the static desktop screenshot with a gallery of the
 * latest CI boot test (frames + result.json from the iso repo's seq/ folder),
 * a status table and a clickable timeline. If anything fails to load, the
 * original screenshot stays. */
(function () {
  var RAW = 'https://raw.githubusercontent.com/pearOS-archlinux/iso/main/seq/';
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
    '.bg-tl{padding:1rem .8rem 1.2rem;border-top:1px solid var(--border);overflow-x:auto}' +
    '.bg-tl ol{list-style:none;margin:0;padding:0;display:flex;min-width:36rem;position:relative}' +
    '.bg-tl ol:before{content:"";position:absolute;left:0;right:0;top:.55rem;height:2px;background:var(--border)}' +
    '.bg-tl li{flex:1;position:relative;text-align:center;font-size:.65rem;color:var(--muted-foreground)}' +
    '.bg-tl button{position:relative;display:block;margin:0 auto .3rem;width:1.1rem;height:1.1rem;border-radius:50%;border:2px solid var(--border);background:var(--card);cursor:pointer;padding:0}' +
    '.bg-tl li.seen button{border-color:#16a34a;background:#16a34a}' +
    '.bg-tl li.key button{width:1.3rem;height:1.3rem;margin-top:-.1rem}' +
    '.bg-tl li.cur button{box-shadow:0 0 0 4px rgba(22,163,74,.3)}' +
    '.bg-tl li.cur{color:inherit;font-weight:600}' +
    '.bg-tl li.bad button{border-color:var(--destructive);background:var(--destructive)}' +
    '.bg-st{width:100%;font-size:.85rem;border-top:1px solid var(--border);border-collapse:collapse}' +
    '.bg-st td{padding:.5rem .8rem;border-bottom:1px solid var(--border)}' +
    '.bg-st tr:last-child td{border-bottom:0}' +
    '.bg-st td:last-child{text-align:right;font-weight:600}' +
    '.bg-ok{color:#16a34a}.bg-no{color:var(--destructive)}';

  function init() {
    if (location.pathname.indexOf('nicecore') < 0) return;
    var img = document.querySelector('img[src$="pearos-desktop.webp"]');
    if (!img) return;
    var host = img.parentElement;
    fetch(RAW + 'result.json', {cache: 'no-cache'}).then(function (r) { return r.json(); }).then(function (res) {
      build(host, res);
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
      '<div class="bg-tl"><ol></ol></div>' + statusHtml;
    host.replaceWith(el);

    var shot = el.querySelector('.bg-screen img'), cap = el.querySelector('.bg-cap');
    var playBtn = el.querySelector('[data-a=play]'), ol = el.querySelector('ol');
    var cur = 1, timer = null, playing = true;

    var lis = [];
    for (var i = 1; i <= n; i++) {
      var li = document.createElement('li');
      var key = notes[i] || i === 1 || i === n;
      li.className = key ? 'key' : '';
      if (!ok && i === n) li.className += ' bad';
      li.innerHTML = '<button aria-label="Frame ' + i + '" title="' + esc(i * iv + ' s · ' + label(i)) + '"></button>' +
        (key ? '<span>' + (i * iv) + 's</span>' : '');
      (function (k) { li.firstChild.onclick = function () { pause(); show(k); }; })(i);
      ol.appendChild(li); lis.push(li);
    }
    function show(i) {
      cur = i;
      shot.src = RAW + 'web/' + i + '.webp';
      cap.textContent = (i * iv) + ' s — ' + label(i);
      lis.forEach(function (l, k) {
        l.classList.toggle('seen', k < i);
        l.classList.toggle('cur', k === i - 1);
      });
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
