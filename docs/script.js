// proxflow page: the sheet's crosshair and zone readout, and the copy button. The page works without it.
(() => {
  const sheet = document.querySelector('.sheet');
  const readout = document.querySelector('[data-zone]');
  const cols = [...document.querySelectorAll('.zones-x span')];
  const rows = [...document.querySelectorAll('.zones-y span')];
  const cross = sheet && sheet.querySelector('.crosshair');

  if (sheet && cross && cols.length === 8 && rows.length === 4) {
    let frame = 0, last = null, lit = [], fade = 0;
    const paint = () => {
      frame = 0;
      const r = sheet.getBoundingClientRect();
      const x = last.clientX - r.left, y = last.clientY - r.top;
      const zone = cols[0].getBoundingClientRect().height;      // width of the zone strip
      const c = Math.min(7, Math.max(0, Math.floor(((x - zone) / (r.width - 2 * zone)) * 8)));
      const w = Math.min(3, Math.max(0, Math.floor(((y - zone) / (r.height - 2 * zone)) * 4)));
      cross.style.setProperty('--cx', `${x}px`);
      cross.style.setProperty('--cy', `${y}px`);
      lit.forEach((el) => el.classList.remove('on'));
      lit = [cols[c], rows[w]];
      lit.forEach((el) => el.classList.add('on'));
      if (readout) readout.textContent = `${'ABCD'[w]}${c + 1}`;
    };
    const show = (e) => {
      last = e;
      sheet.classList.add('tracking');
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const hide = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      sheet.classList.remove('tracking');
      lit.forEach((el) => el.classList.remove('on'));
      lit = [];
      if (readout) readout.textContent = '—';
    };
    // mouse and pen: follow the pointer; touch: a tap marks the spot for a moment
    sheet.addEventListener('pointermove', (e) => { if (e.pointerType !== 'touch') show(e); });
    sheet.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') hide(); });
    sheet.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      show(e);
      clearTimeout(fade);
      fade = setTimeout(hide, 2200);
    });
  }

  for (const button of document.querySelectorAll('[data-copy]')) {
    const source = document.getElementById(button.dataset.copy);
    if (!source) continue;
    button.addEventListener('click', async () => {
      const text = source.textContent.trim();
      let done = false;
      try { await navigator.clipboard.writeText(text); done = true; } catch {
        const range = document.createRange();
        range.selectNodeContents(source);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        done = document.execCommand && document.execCommand('copy');
      }
      button.textContent = done ? 'Copied' : 'Press Ctrl+C';
      clearTimeout(button._t);
      button._t = setTimeout(() => { button.textContent = 'Copy'; }, 1800);
    });
  }
})();
