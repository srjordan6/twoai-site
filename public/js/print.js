/* Print this page (theworldofai rows 424 and 425, Stephen 2026-10-03).
   An external file, so the page needs no inline handler. Without JavaScript
   the button stays hidden (html.can-print is never set) and the browser's own
   print still uses /print.css. */
(function () {
  var root = document.documentElement;
  var btn = document.getElementById('print-btn');
  if (btn) {
    root.classList.add('can-print');
    btn.addEventListener('click', function () { window.print(); });
  }
  // The print date is the day of printing, not the day of the build.
  function stamp() {
    var s = document.querySelector('.print-date');
    if (s) s.textContent = ' · Printed ' + new Date().toISOString().slice(0, 10);
    // Links under a Sources or References heading print their full URL.
    var hs = document.querySelectorAll('main h2, main h3');
    for (var i = 0; i < hs.length; i++) {
      if (!/^(sources?|references)\b/i.test((hs[i].textContent || '').trim())) continue;
      var el = hs[i].nextElementSibling;
      while (el && !/^H[1-3]$/.test(el.tagName)) { el.classList.add('print-src'); el = el.nextElementSibling; }
    }
  }
  stamp();
  window.addEventListener('beforeprint', stamp);
})();
