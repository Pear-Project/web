/* Injects an "Old versions" table (from assets/data/old-versions.json,
 * built by .github/scripts/sync_archive_org.py) right after the versions
 * table on every distro page. The same list is shown everywhere. */
(function () {
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c];
    });
  }
  function init() {
    var anchor = document.querySelector('tbody[id$="-versions-table"]');
    if (!anchor) return;
    var host = anchor.closest('section');
    if (!host || document.getElementById('old-versions')) return;
    var base = document.currentScript ? document.currentScript.src : '';
    var url = base.replace(/js\/old-versions\.js.*$/, 'data/old-versions.json');
    fetch(url, {cache: 'no-store'}).then(function (r) { return r.json(); }).then(function (rows) {
      if (!rows.length) return;
      var body = rows.map(function (v) {
        return '<tr><td class="px-4 py-3 font-medium">' + esc(v.name) + '</td>' +
          '<td class="text-muted-foreground px-4 py-3 text-xs">' + esc(v.date) + '</td>' +
          '<td class="text-muted-foreground px-4 py-3 text-xs">' + esc(v.size || '—') + '</td>' +
          '<td class="px-4 py-3 text-right"><a class="inline-flex items-center justify-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90" href="' +
          esc(v.download) + '" target="_blank" rel="noopener noreferrer">Download</a></td></tr>';
      }).join('');
      var sec = document.createElement('section');
      sec.id = 'old-versions';
      sec.className = 'pb-16 md:pb-28 lg:pb-32';
      sec.innerHTML = '<div class="container max-w-4xl"><h2 class="text-2xl font-semibold">Old versions</h2>' +
        '<p class="text-muted-foreground mt-2 text-sm">Previous pearOS releases, hosted on archive.org.</p>' +
        '<div class="mt-6 overflow-x-auto rounded-xl border"><table class="w-full text-sm">' +
        '<thead class="bg-muted/50 text-muted-foreground text-xs uppercase tracking-wide"><tr>' +
        '<th class="px-4 py-3 text-left font-medium">Version</th><th class="px-4 py-3 text-left font-medium">Archived</th>' +
        '<th class="px-4 py-3 text-left font-medium">Size</th><th class="px-4 py-3 text-right font-medium">Download</th></tr></thead>' +
        '<tbody class="divide-border divide-y">' + body + '</tbody></table></div></div>';
      host.insertAdjacentElement('afterend', sec);
    }).catch(function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
