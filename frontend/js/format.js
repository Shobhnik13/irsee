// Renders mIRC formatting codes (bold, italic, underline, colors...) into DOM nodes.
// Text is only ever inserted via text nodes, never innerHTML, so server input cannot inject markup.

const PALETTE = ['#ffffff', '#000000', '#00007f', '#009300', '#ff0000', '#7f0000', '#9c009c', '#fc7f00', '#ffff00', '#00fc00', '#009393', '#00ffff', '#0000fc', '#ff00ff', '#7f7f7f', '#d2d2d2'];
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'\x00-\x1f]*[^\s<>"'.,;:!?)\]}\x00-\x1f]/gi;
const STRIP_RE = /\x03(?:\d{1,2}(?:,\d{1,2})?)?|\x04(?:[0-9a-f]{6}(?:,[0-9a-f]{6})?)?|[\x02\x0f\x11\x16\x1d\x1e\x1f]/gi;

export function strip(text) {
  return text.replace(STRIP_RE, '');
}

const fresh = () => ({b: false, i: false, u: false, s: false, m: false, r: false, fg: null, bg: null});

export function render(text, parent) {
  if (!/[\x02\x03\x04\x0f\x11\x16\x1d\x1e\x1f]/.test(text)) {
    linkify(text, parent);
    return;
  }

  let st = fresh();
  let buf = '';

  const flush = () => {
    if (!buf) return;
    const plain = !st.b && !st.i && !st.u && !st.s && !st.m && !st.r && st.fg === null && st.bg === null;
    let target = parent;
    if (!plain) {
      target = document.createElement('span');
      const cls = [];
      if (st.b) cls.push('f-b');
      if (st.i) cls.push('f-i');
      if (st.u) cls.push('f-u');
      if (st.s) cls.push('f-s');
      if (st.m) cls.push('f-m');
      target.className = cls.join(' ');
      let fg = st.fg;
      let bg = st.bg;
      if (st.r) [fg, bg] = [bg ?? 'var(--bg)', fg ?? 'var(--fg)'];
      if (fg !== null) target.style.color = fg;
      if (bg !== null) target.style.backgroundColor = bg;
      parent.appendChild(target);
    }
    linkify(buf, target);
    buf = '';
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    switch (ch) {
      case '\x02': flush(); st.b = !st.b; break;
      case '\x1d': flush(); st.i = !st.i; break;
      case '\x1f': flush(); st.u = !st.u; break;
      case '\x1e': flush(); st.s = !st.s; break;
      case '\x11': flush(); st.m = !st.m; break;
      case '\x16': flush(); st.r = !st.r; break;
      case '\x0f': flush(); st = fresh(); break;
      case '\x03': {
        flush();
        const m = /^(\d{1,2})(?:,(\d{1,2}))?/.exec(text.slice(i + 1, i + 6));
        if (m) {
          st.fg = color(+m[1]);
          if (m[2] !== undefined) st.bg = color(+m[2]);
          i += m[0].length;
        } else {
          st.fg = st.bg = null;
        }
        break;
      }
      case '\x04': {
        flush();
        const m = /^([0-9a-f]{6})(?:,([0-9a-f]{6}))?/i.exec(text.slice(i + 1, i + 15));
        if (m) {
          st.fg = '#' + m[1];
          if (m[2] !== undefined) st.bg = '#' + m[2];
          i += m[0].length;
        } else {
          st.fg = st.bg = null;
        }
        break;
      }
      default:
        buf += ch;
    }
  }
  flush();
}

function color(n) {
  return n < 16 ? PALETTE[n] : null;
}

function linkify(text, parent) {
  URL_RE.lastIndex = 0;
  let last = 0;
  let m;
  while ((m = URL_RE.exec(text))) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    const a = document.createElement('a');
    a.className = 'link';
    a.textContent = m[0];
    a.dataset.url = m[0].startsWith('www.') ? 'https://' + m[0] : m[0];
    a.title = a.dataset.url;
    parent.appendChild(a);
    last = m.index + m[0].length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(last ? text.slice(last) : text));
}
