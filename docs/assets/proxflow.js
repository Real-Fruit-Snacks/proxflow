// proxflow page: screen tabs, and the brand motions that need JS (BRAND.md section 8):
// the dot grid warming around the pointer, the terminal playing when it comes into view, and the
// theme switch sweeping in from the control. The shared site.js stays untouched.
(function () {
  var still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Screens: Build / Map. Without JS both figures simply show, one after the other.
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tour-tabs [role="tab"]'));
  function select(tab) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    });
  }
  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { select(t); });
    t.addEventListener('keydown', function (e) {
      var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      var next = tabs[(i + d + tabs.length) % tabs.length];
      select(next);
      next.focus();
    });
  });
  if (tabs.length) select(tabs[0]);

  // The dot grid warms to Ember around the pointer (fine pointers; CSS hides it in Dayshift).
  var hero = document.querySelector('.hero');
  if (hero && !still && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    var raf = 0, px = 0, py = 0;
    hero.addEventListener('pointermove', function (e) {
      var r = hero.getBoundingClientRect();
      px = e.clientX - r.left; py = e.clientY - r.top;
      if (!raf) raf = requestAnimationFrame(function () {
        hero.style.setProperty('--x', px + 'px');
        hero.style.setProperty('--y', py + 'px');
        hero.classList.add('warm');
        raf = 0;
      });
    });
    hero.addEventListener('pointerleave', function () { hero.classList.remove('warm'); });
  }

  // The terminal types its command and prints its output once it is on screen.
  var term = document.querySelector('.term[data-type]');
  if (term && 'IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting) { term.classList.add('play'); io.disconnect(); }
    }, { threshold: 0.5 });
    io.observe(term);
  } else if (term) {
    term.classList.add('play');
  }

  // The theme switch sweeps the new theme in from the control, in a circle.
  // site.js owns the toggle; this wraps its click in a view transition.
  var btn = document.getElementById('theme');
  var passing = false;
  if (btn && document.startViewTransition && !still) {
    btn.addEventListener('click', function (e) {
      if (passing) return;                       // the re-dispatched click: let site.js flip the theme
      e.stopImmediatePropagation();
      var r = btn.getBoundingClientRect();
      var x = r.left + r.width / 2, y = r.top + r.height / 2;
      var radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
      var vt = document.startViewTransition(function () { passing = true; btn.click(); passing = false; });
      vt.ready.then(function () {
        document.documentElement.animate(
          { clipPath: ['circle(0 at ' + x + 'px ' + y + 'px)', 'circle(' + radius + 'px at ' + x + 'px ' + y + 'px)'] },
          { duration: 600, easing: 'cubic-bezier(.2, .7, .2, 1)', pseudoElement: '::view-transition-new(root)' });
      }).catch(function () {});
    }, true);
  }
})();
