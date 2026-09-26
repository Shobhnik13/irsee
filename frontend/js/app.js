import {render, strip} from './format.js';
import {COMMANDS, SLASH_NAMES, banMask, massMode, parseSlash} from './commands.js';

const api = window.go.backend.App;
const rt = window.runtime;

const MAX_LINES = 3000;
const LIST_ROWS = 300;
const SERVER = '*';
const VERSION = 'irsee 1.0';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const lc = (s) => (s || '').toLowerCase().replace(/[[\]\\~]/g, (c) => ({'[': '{', ']': '}', '\\': '|', '~': '^'})[c]);
const pad = (n) => String(n).padStart(2, '0');
const fmtTime = (t) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fmtSize = (n) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i && n < 10 ? 1 : 0)} ${u[i]}`;
};
const fmtDate = (sec) => new Date(sec * 1000).toLocaleString();
const fmtDur = (s) => {
  const parts = [[86400, 'd'], [3600, 'h'], [60, 'm'], [1, 's']].map(([n, u]) => {
    const v = Math.floor(s / n);
    s %= n;
    return v ? v + u : '';
  });
  return parts.filter(Boolean).join(' ') || '0s';
};

const S = {
  config: {servers: []},
  servers: new Map(),
  active: null,
  pending: [],
  dirty: {},
  history: [],
  histPos: 0,
  modal: null,
  transfers: new Map(),
};

const ui = {
  app: $('#app'),
  buffers: $('#buffers'),
  title: $('#title'),
  topic: $('#topic'),
  messages: $('#messages'),
  input: $('#input'),
  me: $('#me'),
  nicks: $('#nicks'),
  nlCount: $('#nl-count'),
  overlay: $('#overlay'),
  modal: $('#modal'),
  menu: $('#menu'),
  toasts: $('#toasts'),
};

// ---------- State ----------

function addServer(cfg) {
  const srv = {
    cfg,
    status: 'disconnected',
    nick: cfg.nick,
    isupport: {prefixModes: 'ov', prefixSyms: '@+', chantypes: '#&', chanmodes: ['beI', 'k', 'l', 'imnpst'], network: '', modes: 3},
    buffers: new Map(),
    names: {},
    list: null,
    lastCtcp: 0,
  };
  srv.buffers.set(SERVER, newBuffer(SERVER, 'server'));
  S.servers.set(cfg.id, srv);
  return srv;
}

function newBuffer(name, type) {
  return {name, type, lines: [], unread: 0, hl: false, topic: '', users: new Map(), joined: false, rejoin: false, namesLoading: false};
}

const serverBuf = (srv) => srv.buffers.get(SERVER);
const serverName = (srv) => srv.cfg.name || srv.isupport.network || srv.cfg.host;
const isChan = (srv, s) => !!s && srv.isupport.chantypes.includes(s[0]);
const isMe = (srv, nick) => !!nick && lc(nick) === lc(srv.nick);
const findBuf = (srv, name) => srv.buffers.get(lc(name));
const isActive = (srv, buf) => S.active && S.active.srv === srv && S.active.buf === buf;
const activeSrv = () => S.active?.srv || S.servers.values().next().value || null;

function getBuf(srv, name, type) {
  let b = srv.buffers.get(lc(name));
  if (!b) {
    b = newBuffer(name, type);
    srv.buffers.set(lc(name), b);
    dirty('side');
  }
  return b;
}

// Where replies to user-initiated queries (WHOIS, errors...) show up.
function infoBuf(srv) {
  return S.active?.srv === srv ? S.active.buf : serverBuf(srv);
}

function addLine(srv, buf, line) {
  line.t ??= Date.now();
  buf.lines.push(line);
  if (buf.lines.length > MAX_LINES + 200) buf.lines.splice(0, buf.lines.length - MAX_LINES);

  if (isActive(srv, buf)) {
    S.pending.push(line);
    dirty('msgs');
  } else if (line.kind === 'msg' || line.kind === 'action' || line.kind === 'notice') {
    buf.unread++;
    if (line.hl || (buf.type === 'query' && !line.self)) buf.hl = true;
    dirty('side');
  }
}

const sys = (srv, buf, kind, text) => addLine(srv, buf, {kind, text});

function setUser(buf, nick, prefixes = '') {
  const k = lc(nick);
  const u = buf.users.get(k);
  if (u) u.p = prefixes || u.p;
  else buf.users.set(k, {nick, lk: k, p: prefixes});
}

function remember(srv, channel, on) {
  const list = srv.cfg.channels || (srv.cfg.channels = []);
  const i = list.findIndex((c) => lc(c.split(' ')[0]) === lc(channel));
  if (on && i < 0) list.push(channel);
  else if (!on && i >= 0) list.splice(i, 1);
  else return;
  saveConfig();
}

// ---------- Render scheduling ----------

let raf = 0;
function dirty(...keys) {
  for (const k of keys) S.dirty[k] = true;
  if (!raf) raf = requestAnimationFrame(flush);
}

function flush() {
  raf = 0;
  const d = S.dirty;
  S.dirty = {};
  if (d.side) renderSidebar();
  if (d.bar) renderBar();
  if (d.nicks) renderNicks();
  if (d.full || S.pending.length > MAX_LINES) renderMessages();
  else if (S.pending.length) appendPending();
  if (d.list && S.modal?.type === 'list') S.modal.update();
  if (d.xfer) {
    renderFilesButton();
    if (S.modal?.type === 'transfers') S.modal.update();
  }
}

// ---------- Rendering ----------

function nickColor(n) {
  let h = 0;
  for (const ch of n.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} var(--nick-s) var(--nick-l))`;
}

const SYS_MARK = {join: '→', part: '←', error: '!', notice: '-'};

function lineEl(l) {
  const d = el('div', `line k-${l.kind}${l.hl ? ' hl' : ''}`);
  d.appendChild(el('span', 'ts', fmtTime(l.t)));
  if (l.from) {
    const f = el('span', 'from', l.kind === 'action' ? `* ${l.from}` : l.kind === 'notice' ? `-${l.from}-` : l.from);
    f.style.color = nickColor(l.from);
    f.dataset.nick = l.from;
    d.appendChild(f);
  } else {
    d.appendChild(el('span', 'from sys', SYS_MARK[l.kind] || '•'));
  }
  const tx = el('span', 'text');
  render(l.text, tx);
  d.appendChild(tx);
  return d;
}

function renderMessages() {
  S.pending = [];
  const box = ui.messages;
  box.textContent = '';
  if (!S.active) {
    const e = el('div', 'empty');
    e.appendChild(el('h2', null, 'Welcome to irsee'));
    e.appendChild(el('div', null, 'Add a server with the + button to get started.'));
    box.appendChild(e);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const l of S.active.buf.lines.slice(-MAX_LINES)) frag.appendChild(lineEl(l));
  box.appendChild(frag);
  box.scrollTop = box.scrollHeight;
}

function appendPending() {
  const box = ui.messages;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const frag = document.createDocumentFragment();
  for (const l of S.pending) frag.appendChild(lineEl(l));
  S.pending = [];
  box.appendChild(frag);
  let extra = box.childElementCount - MAX_LINES;
  while (extra-- > 0) box.firstElementChild.remove();
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function renderSidebar() {
  const frag = document.createDocumentFragment();
  const typeOrder = {channel: 0, query: 1};

  for (const srv of S.servers.values()) {
    const sb = serverBuf(srv);
    frag.appendChild(bufRow(srv, sb, 'server', serverName(srv), el('span', `dot s-${srv.status}`)));

    const bufs = [...srv.buffers.values()].filter((b) => b.type !== 'server');
    bufs.sort((a, b) => typeOrder[a.type] - typeOrder[b.type] || (lc(a.name) < lc(b.name) ? -1 : 1));
    for (const b of bufs) {
      frag.appendChild(bufRow(srv, b, `child${b.type === 'channel' && !b.joined ? ' parted' : ''}`, b.name));
    }
  }
  ui.buffers.replaceChildren(frag);
}

function bufRow(srv, buf, cls, name, lead) {
  const row = el('div', `buf ${cls}${isActive(srv, buf) ? ' active' : ''}${buf.unread ? ' unread' : ''}`);
  if (lead) row.appendChild(lead);
  row.appendChild(el('span', 'name', name));
  if (buf.unread) row.appendChild(el('span', `badge${buf.hl ? ' hl' : ''}`, buf.unread > 999 ? '999+' : buf.unread));
  if (buf.type !== 'server') {
    const x = el('button', 'close', '×');
    x.title = buf.type === 'channel' ? 'Leave channel' : 'Close';
    x.onclick = (e) => {
      e.stopPropagation();
      closeBuffer(srv, buf);
    };
    row.appendChild(x);
  }
  row.onclick = () => select(srv, buf);
  row.oncontextmenu = (e) => (buf.type === 'server' ? serverMenu(e, srv) : bufferMenu(e, srv, buf));
  return row;
}

function renderBar() {
  ui.topic.textContent = '';
  if (!S.active) {
    ui.title.textContent = 'irsee';
    ui.me.textContent = '';
    return;
  }
  const {srv, buf} = S.active;
  ui.me.textContent = srv.nick;
  if (buf.type === 'server') {
    ui.title.textContent = serverName(srv);
    ui.topic.textContent = `${srv.cfg.host}:${srv.cfg.port}${srv.cfg.tls ? ' (TLS)' : ''} — ${srv.status}`;
  } else {
    ui.title.textContent = buf.name;
    if (buf.type === 'channel') {
      render(buf.topic || (buf.joined ? '' : 'Not in channel'), ui.topic);
      ui.topic.title = strip(buf.topic);
    } else {
      ui.topic.textContent = 'Private conversation';
    }
  }
}

function renderNicks() {
  const buf = S.active?.buf;
  const show = buf?.type === 'channel';
  ui.app.classList.toggle('no-nicks', !show);
  if (!show) return;

  const syms = S.active.srv.isupport.prefixSyms;
  const rank = (u) => (u.p ? syms.indexOf(u.p[0]) : 99);
  const users = [...buf.users.values()].sort((a, b) => rank(a) - rank(b) || (a.lk < b.lk ? -1 : a.lk > b.lk ? 1 : 0));

  ui.nlCount.textContent = `${users.length} user${users.length === 1 ? '' : 's'}`;
  const frag = document.createDocumentFragment();
  for (const u of users) {
    const li = el('li');
    li.dataset.nick = u.nick;
    li.appendChild(el('span', 'pfx', u.p[0] || ''));
    li.appendChild(document.createTextNode(u.nick));
    frag.appendChild(li);
  }
  ui.nicks.replaceChildren(frag);
}

function select(srv, buf) {
  S.active = {srv, buf};
  buf.unread = 0;
  buf.hl = false;
  dirty('side', 'bar', 'nicks', 'full');
  if (!S.modal) ui.input.focus();
}

// ---------- IRC events ----------

rt.EventsOn('irc', (batch) => {
  for (const ev of batch) {
    const srv = S.servers.get(ev.server);
    if (!srv) continue;
    if (ev.kind === 'state') onState(srv, ev);
    else if (ev.kind === 'dcc') onTransfer(srv, ev.dcc);
    else onMessage(srv, ev.msg);
  }
});

function onState(srv, ev) {
  srv.status = ev.state;
  if (ev.nick) srv.nick = ev.nick;
  const sb = serverBuf(srv);

  switch (ev.state) {
    case 'connecting':
      sys(srv, sb, 'info', `Connecting to ${srv.cfg.host}:${srv.cfg.port}${srv.cfg.tls ? ' (TLS)' : ''}…`);
      break;
    case 'registered': {
      sys(srv, sb, 'info', `Connected as ${srv.nick}`);
      const want = new Map();
      for (const c of srv.cfg.channels || []) want.set(lc(c.split(' ')[0]), c);
      for (const b of srv.buffers.values()) if (b.type === 'channel' && b.rejoin && !want.has(lc(b.name))) want.set(lc(b.name), b.name);
      for (const c of want.values()) send(srv, `JOIN ${c}`);
      break;
    }
    case 'reconnecting':
    case 'disconnected':
      for (const b of srv.buffers.values()) {
        if (b.type !== 'channel') continue;
        b.joined = false;
        b.users.clear();
      }
      sys(srv, sb, ev.state === 'reconnecting' ? 'error' : 'info', ev.state === 'reconnecting' ? `Disconnected: ${ev.error}` : 'Disconnected');
      break;
  }
  dirty('side', 'bar', 'nicks');
}

function onMessage(srv, m) {
  const p = m.params;
  const me = isMe(srv, m.nick);
  const t = m.time;

  switch (m.command) {
    case 'PRIVMSG':
    case 'NOTICE':
      return onPrivmsg(srv, m);

    case 'JOIN': {
      const b = getBuf(srv, p[0], 'channel');
      if (me) {
        b.joined = true;
        b.rejoin = true;
        b.users.clear();
        remember(srv, b.name, true);
        dirty('side', 'bar');
      }
      setUser(b, m.nick);
      addLine(srv, b, {t, kind: 'join', text: `${m.nick} (${m.user}@${m.host}) joined ${p[0]}`});
      if (isActive(srv, b)) dirty('nicks');
      return;
    }

    case 'PART': {
      const b = findBuf(srv, p[0]);
      if (!b) return;
      if (me) {
        b.joined = false;
        b.rejoin = false;
        b.users.clear();
        remember(srv, b.name, false);
        dirty('side', 'bar');
      } else {
        b.users.delete(lc(m.nick));
      }
      addLine(srv, b, {t, kind: 'part', text: `${m.nick} left ${p[0]}${p[1] ? ` (${p[1]})` : ''}`});
      if (isActive(srv, b)) dirty('nicks');
      return;
    }

    case 'KICK': {
      const b = findBuf(srv, p[0]);
      if (!b) return;
      const victimMe = isMe(srv, p[1]);
      if (victimMe) {
        b.joined = false;
        b.rejoin = false;
        b.users.clear();
        dirty('side', 'bar');
      } else {
        b.users.delete(lc(p[1]));
      }
      addLine(srv, b, {t, kind: 'part', hl: victimMe, text: `${p[1]} was kicked by ${m.nick}${p[2] ? ` (${p[2]})` : ''}`});
      if (isActive(srv, b)) dirty('nicks');
      return;
    }

    case 'QUIT': {
      const k = lc(m.nick);
      const text = `${m.nick} quit${p[0] ? ` (${p[0]})` : ''}`;
      for (const b of srv.buffers.values()) {
        if ((b.type === 'channel' && b.users.delete(k)) || (b.type === 'query' && lc(b.name) === k)) {
          addLine(srv, b, {t, kind: 'part', text});
          if (isActive(srv, b)) dirty('nicks');
        }
      }
      return;
    }

    case 'NICK': {
      const oldK = lc(m.nick);
      const nn = p[0];
      if (me) {
        srv.nick = nn;
        sys(srv, serverBuf(srv), 'event', `You are now known as ${nn}`);
        dirty('bar');
      }
      const text = `${m.nick} is now known as ${nn}`;
      for (const b of srv.buffers.values()) {
        const u = b.users.get(oldK);
        if (u) {
          b.users.delete(oldK);
          u.nick = nn;
          u.lk = lc(nn);
          b.users.set(u.lk, u);
          addLine(srv, b, {t, kind: 'event', text});
          if (isActive(srv, b)) dirty('nicks');
        }
      }
      const q = srv.buffers.get(oldK);
      if (q?.type === 'query' && !srv.buffers.has(lc(nn))) {
        srv.buffers.delete(oldK);
        q.name = nn;
        srv.buffers.set(lc(nn), q);
        addLine(srv, q, {t, kind: 'event', text});
        dirty('side', 'bar');
      }
      return;
    }

    case 'MODE': {
      const text = `${m.nick || serverName(srv)} sets mode ${p.slice(1).join(' ')}`;
      if (isChan(srv, p[0])) {
        const b = findBuf(srv, p[0]);
        if (!b) return;
        applyModes(srv, b, p[1], p.slice(2));
        addLine(srv, b, {t, kind: 'mode', text});
      } else {
        sys(srv, serverBuf(srv), 'mode', `Your modes: ${p.slice(1).join(' ')}`);
      }
      return;
    }

    case 'TOPIC': {
      const b = findBuf(srv, p[0]);
      if (!b) return;
      b.topic = p[1] || '';
      addLine(srv, b, {t, kind: 'event', text: `${m.nick} changed the topic to: ${b.topic}`});
      if (isActive(srv, b)) dirty('bar');
      return;
    }

    case 'INVITE':
      if (isMe(srv, p[0])) sys(srv, infoBuf(srv), 'notice', `${m.nick} invited you to ${p[1]} — type /join ${p[1]}`);
      else sys(srv, findBuf(srv, p[1]) || infoBuf(srv), 'event', `${m.nick} invited ${p[0]} to ${p[1]}`);
      return;

    case 'ERROR':
      sys(srv, serverBuf(srv), 'error', p[0] || 'Server error');
      return;

    case 'WALLOPS':
      addLine(srv, serverBuf(srv), {t, kind: 'notice', from: m.nick || serverName(srv), text: `[wallops] ${p[0]}`});
      return;

    case 'CAP':
      sys(srv, serverBuf(srv), 'info', `CAP ${p.slice(1).join(' ')}`);
      return;

    case 'AWAY':
    case 'ACCOUNT':
    case 'CHGHOST':
    case 'SETNAME':
      return;
  }

  if (/^\d{3}$/.test(m.command)) onNumeric(srv, m);
  else sys(srv, serverBuf(srv), 'info', `${m.command} ${p.join(' ')}`);
}

function onPrivmsg(srv, m) {
  const notice = m.command === 'NOTICE';
  const [target, raw = ''] = m.params;
  const fromServer = !m.nick || (!m.user && !m.host && m.nick.includes('.'));
  const me = isMe(srv, m.nick);

  let tgt = target;
  while (tgt && srv.isupport.prefixSyms.includes(tgt[0]) && isChan(srv, tgt.slice(1))) tgt = tgt.slice(1);

  let text = raw;
  let kind = notice ? 'notice' : 'msg';
  const ctcp = /^\x01(\S+)(?: ([^\x01]*))?\x01?$/.exec(raw);
  if (ctcp) {
    const cmd = ctcp[1].toUpperCase();
    const args = ctcp[2] || '';
    if (cmd !== 'ACTION') {
      if (notice) {
        const extra = cmd === 'PING' && /^\d+$/.test(args) ? `${Date.now() - +args} ms` : args;
        sys(srv, infoBuf(srv), 'notice', `CTCP ${cmd} reply from ${m.nick}: ${extra}`);
      } else {
        ctcpReply(srv, m.nick, cmd, args);
      }
      return;
    }
    kind = 'action';
    text = args;
  }

  let buf;
  if (isChan(srv, tgt)) buf = getBuf(srv, tgt, 'channel');
  else if (fromServer || tgt === '*') buf = serverBuf(srv);
  else if (notice) buf = findBuf(srv, m.nick) || infoBuf(srv);
  else buf = getBuf(srv, me ? tgt : m.nick, 'query');

  const hl = !me && buf.type === 'channel' && mentions(srv, text);
  addLine(srv, buf, {t: m.time, kind, from: m.nick || serverName(srv), text, hl, self: me});
}

function ctcpReply(srv, nick, cmd, args) {
  const now = Date.now();
  sys(srv, infoBuf(srv), 'info', `CTCP ${cmd} from ${nick}`);
  if (now - srv.lastCtcp < 2000) return;
  const reply = {VERSION: VERSION, PING: args, TIME: new Date().toString(), CLIENTINFO: 'ACTION CLIENTINFO PING TIME VERSION'}[cmd];
  if (reply === undefined) return;
  srv.lastCtcp = now;
  api.Send(srv.cfg.id, `NOTICE ${nick} :\x01${cmd}${reply ? ' ' + reply : ''}\x01`).catch(() => {});
}

const mentionCache = new Map();
function mentions(srv, text) {
  let re = mentionCache.get(srv.nick);
  if (!re) {
    re = new RegExp(`(^|[^\\w\\[\\]\\\\\`^{|}-])${srv.nick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w\\[\\]\\\\\`^{|}-])`, 'i');
    mentionCache.set(srv.nick, re);
  }
  return re.test(strip(text));
}

function applyModes(srv, buf, modes = '', args) {
  const {prefixModes, prefixSyms, chanmodes} = srv.isupport;
  let sign = '+';
  let ai = 0;
  for (const c of modes) {
    if (c === '+' || c === '-') {
      sign = c;
      continue;
    }
    const pi = prefixModes.indexOf(c);
    if (pi >= 0) {
      const u = buf.users.get(lc(args[ai++]));
      if (u) {
        const sym = prefixSyms[pi];
        u.p = sign === '+' ? [...new Set(u.p + sym)].sort((a, b) => prefixSyms.indexOf(a) - prefixSyms.indexOf(b)).join('') : u.p.replace(sym, '');
      }
      continue;
    }
    if (chanmodes[0].includes(c) || chanmodes[1].includes(c) || (sign === '+' && chanmodes[2].includes(c))) ai++;
  }
  if (isActive(srv, buf)) dirty('nicks');
}

function parseIsupport(srv, tokens) {
  const is = srv.isupport;
  for (const tok of tokens) {
    const eq = tok.indexOf('=');
    const k = (eq < 0 ? tok : tok.slice(0, eq)).toUpperCase();
    const v = eq < 0 ? '' : tok.slice(eq + 1);
    if (k === 'PREFIX') {
      const pm = /^\(([^)]*)\)(.*)$/.exec(v);
      if (pm) [is.prefixModes, is.prefixSyms] = [pm[1], pm[2]];
    } else if (k === 'CHANTYPES') {
      is.chantypes = v;
    } else if (k === 'CHANMODES') {
      const parts = v.split(',');
      is.chanmodes = [0, 1, 2, 3].map((i) => parts[i] || '');
    } else if (k === 'NETWORK') {
      is.network = v;
      dirty('side', 'bar');
    } else if (k === 'MODES') {
      is.modes = +v || 3;
    }
  }
}

const WHOIS = {
  311: (p) => `${p[1]} is ${p[2]}@${p[3]} (${p[5]})`,
  312: (p) => `${p[1]} is connected to ${p[2]} (${p[3]})`,
  313: (p) => `${p[1]} ${p[2]}`,
  314: (p) => `${p[1]} was ${p[2]}@${p[3]} (${p[5]})`,
  317: (p) => `${p[1]} has been idle ${fmtDur(+p[2])}${/^\d+$/.test(p[3]) ? `, signed on ${fmtDate(+p[3])}` : ''}`,
  318: (p) => `End of WHOIS for ${p[1]}`,
  319: (p) => `${p[1]} is on ${p[2]}`,
  330: (p) => `${p[1]} is logged in as ${p[2]}`,
  369: (p) => `End of WHOWAS for ${p[1]}`,
  671: (p) => `${p[1]} is using a secure connection`,
};

function onNumeric(srv, m) {
  const p = m.params;
  const code = +m.command;
  const generic = p.slice(1).join(' ');

  switch (code) {
    case 1:
      srv.nick = p[0];
      sys(srv, serverBuf(srv), 'info', p[1] || generic);
      dirty('bar');
      return;
    case 5:
      parseIsupport(srv, p.slice(1, -1));
      return;
    case 301: {
      const q = findBuf(srv, p[1]);
      sys(srv, q || infoBuf(srv), 'info', `${p[1]} is away: ${p[2]}`);
      return;
    }
    case 305:
    case 306:
      sys(srv, infoBuf(srv), 'info', p[1]);
      return;
    case 321:
      srv.list = {items: [], done: false};
      dirty('list');
      return;
    case 322:
      (srv.list ??= {items: [], done: false}).items.push({ch: p[1], n: +p[2] || 0, topic: strip(p[3] || '')});
      dirty('list');
      return;
    case 323:
      if (srv.list) srv.list.done = true;
      else srv.list = {items: [], done: true};
      dirty('list');
      if (S.modal?.type !== 'list') sys(srv, infoBuf(srv), 'info', `Channel list ready (${srv.list.items.length}) — click "Channels" to browse`);
      return;
    case 324: {
      const b = findBuf(srv, p[1]);
      sys(srv, b || infoBuf(srv), 'info', `Channel modes: ${p.slice(2).join(' ')}`);
      return;
    }
    case 329:
      sys(srv, findBuf(srv, p[1]) || infoBuf(srv), 'info', `Channel created ${fmtDate(+p[2])}`);
      return;
    case 331:
    case 332: {
      const b = findBuf(srv, p[1]);
      if (b) {
        b.topic = code === 332 ? p[2] : '';
        if (isActive(srv, b)) dirty('bar');
      }
      sys(srv, b || infoBuf(srv), 'event', code === 332 ? `Topic for ${p[1]}: ${p[2]}` : `No topic set for ${p[1]}`);
      return;
    }
    case 333:
      sys(srv, findBuf(srv, p[1]) || infoBuf(srv), 'event', `Topic set by ${(p[2] || '').split('!')[0]} on ${fmtDate(+p[3])}`);
      return;
    case 353: {
      const b = findBuf(srv, p[2]);
      const names = (p[3] || '').split(' ').filter(Boolean);
      if (b?.joined) {
        if (!b.namesLoading) {
          b.users.clear();
          b.namesLoading = true;
        }
        const syms = srv.isupport.prefixSyms;
        for (const n of names) {
          let i = 0;
          while (i < n.length && syms.includes(n[i])) i++;
          setUser(b, n.slice(i).split('!')[0], n.slice(0, i));
        }
        if (isActive(srv, b)) dirty('nicks');
      } else {
        (srv.names[lc(p[2])] ??= []).push(...names);
      }
      return;
    }
    case 366: {
      const b = findBuf(srv, p[1]);
      if (b?.namesLoading) {
        b.namesLoading = false;
        sys(srv, b, 'info', `${b.users.size} users in ${b.name}`);
      } else if (srv.names[lc(p[1])]) {
        sys(srv, infoBuf(srv), 'info', `Users in ${p[1]}: ${srv.names[lc(p[1])].join(' ')}`);
        delete srv.names[lc(p[1])];
      }
      return;
    }
  }

  if (WHOIS[code]) return sys(srv, infoBuf(srv), 'info', WHOIS[code](p));
  if (code >= 400 && code < 600) return sys(srv, infoBuf(srv), 'error', generic);
  if (code < 100 || (code >= 250 && code <= 266) || (code >= 372 && code <= 376) || code === 422) return sys(srv, serverBuf(srv), 'info', generic);
  sys(srv, infoBuf(srv), 'info', generic);
}

// ---------- File transfers (DCC) ----------

const FINAL = new Set(['done', 'failed', 'cancelled', 'rejected']);
const XFER_STATE = {offered: 'waiting for you', waiting: 'waiting for peer', connecting: 'connecting', active: 'transferring', done: 'done', failed: 'failed', cancelled: 'cancelled', rejected: 'rejected'};

function onTransfer(srv, t) {
  const prev = S.transfers.get(t.id);
  S.transfers.set(t.id, t);
  const buf = findBuf(srv, t.nick) || infoBuf(srv);

  if (!prev && t.dir === 'recv') {
    addLine(srv, buf, {kind: 'notice', from: t.nick, hl: true, text: `wants to send you ${t.name} (${t.size ? fmtSize(t.size) : 'unknown size'}) — open Files to accept or reject`});
    if (!S.modal) openTransfers();
    else toast(`${t.nick} wants to send you ${t.name}`);
  } else if (prev?.state !== t.state && FINAL.has(t.state) && t.state !== 'cancelled') {
    const verb = t.dir === 'send' ? `Sending ${t.name} to` : `Receiving ${t.name} from`;
    sys(srv, buf, t.state === 'done' ? 'info' : 'error', `${verb} ${t.nick}: ${t.state}${t.error ? ` (${t.error})` : ''}`);
  }
  dirty('xfer');
}

function renderFilesButton() {
  const n = [...S.transfers.values()].filter((t) => !FINAL.has(t.state)).length;
  const b = $('#btn-dcc');
  b.textContent = n ? `Files (${n})` : 'Files';
  b.classList.toggle('has-badge', n > 0);
}

async function sendFile(srv, nick, passive) {
  try {
    const id = await api.DCCSendFile(srv.cfg.id, nick, !!passive);
    if (id) sys(srv, findBuf(srv, nick) || infoBuf(srv), 'info', `Offering a file to ${nick}${passive ? ' (passive)' : ''}…`);
  } catch (e) {
    sys(srv, infoBuf(srv), 'error', `Cannot send file: ${e}`);
  }
}

const call = (p) => p.catch((e) => toast(String(e)));

function openTransfers() {
  const list = el('div');
  const bar = el('div', 'xfer-send');
  const who = el('input');
  who.id = 'xfer-nick';
  who.placeholder = 'Nick to send to';
  const ctx = context();
  who.value = ctx.target && !ctx.channel ? ctx.target : '';
  const mode = el('select');
  mode.id = 'xfer-mode';
  for (const [v, label] of [['active', 'Active'], ['passive', 'Passive (you connect to them)']]) mode.appendChild(Object.assign(el('option', null, label), {value: v}));
  const go = el('button', 'primary', 'Send file…');
  go.onclick = () => {
    const nick = who.value.trim();
    const srv = activeSrv();
    if (!nick) return who.focus();
    if (!srv) return toast('Add a server first');
    sendFile(srv, nick, mode.value === 'passive');
  };
  who.onkeydown = (e) => e.key === 'Enter' && go.onclick();
  bar.append(who, mode, go);
  const body = el('div');
  body.append(bar, list);
  const foot = footer([
    {
      label: 'Clear finished',
      onClick: async () => {
        await api.DCCClear();
        for (const [id, t] of S.transfers) if (FINAL.has(t.state)) S.transfers.delete(id);
        dirty('xfer');
      },
    },
    '|',
    {label: 'Close', onClick: closeModal},
  ]);
  const modal = openModal('transfers', 'File transfers', body, foot, {wide: true});
  const reveal = /Mac/.test(navigator.platform) ? 'Show in Finder' : 'Show in folder';

  modal.update = () => {
    const items = [...S.transfers.values()].sort((a, b) => +b.id - +a.id);
    if (!items.length) {
      list.replaceChildren(el('div', 'muted', 'No transfers yet. Send one above, right-click a nick, or type /dcc send nick (/dcc psend nick for passive).'));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const t of items) {
      const row = el('div', `xfer s-${t.state}`);
      row.appendChild(el('div', 'x-name', `${t.dir === 'send' ? '↑' : '↓'} ${t.name}`));

      const actions = el('div', 'x-actions');
      const btn = (label, cls, fn) => {
        const b = el('button', cls, label);
        b.onclick = fn;
        actions.appendChild(b);
      };
      if (t.state === 'offered') {
        btn('Accept', 'primary', () => call(api.DCCAccept(t.id, false)));
        btn('Save as…', '', () => call(api.DCCAccept(t.id, true)));
        btn('Reject', 'danger', () => api.DCCCancel(t.id));
      } else if (!FINAL.has(t.state)) {
        btn('Cancel', 'danger', () => api.DCCCancel(t.id));
      } else if (t.state === 'done' && t.path) {
        btn(reveal, '', () => call(api.DCCReveal(t.id)));
      }
      row.appendChild(actions);

      const size = t.size ? ` / ${fmtSize(t.size)}` : '';
      const speed = t.speed ? ` · ${fmtSize(t.speed)}/s` : '';
      row.appendChild(el('div', 'x-meta', `${t.dir === 'send' ? 'to' : 'from'} ${t.nick} · ${fmtSize(t.done)}${size}${speed} · ${XFER_STATE[t.state] || t.state}${t.peer ? ` · ${t.peer}` : ''}`));

      const track = el('div', 'bar-track');
      const fill = el('div', 'bar-fill');
      fill.style.width = `${t.size ? Math.min(100, (t.done / t.size) * 100) : t.state === 'done' ? 100 : 0}%`;
      track.appendChild(fill);
      row.appendChild(track);
      if (t.error) row.appendChild(el('div', 'x-err', t.error));
      frag.appendChild(row);
    }
    list.replaceChildren(frag);
  };
  modal.update();
}

// ---------- Sending ----------

function utf8Chunks(text, max = 400) {
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + n > max) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  if (cur) out.push(cur);
  return out;
}

const SECRET_RE = /^(identify|register|regain|ghost|recover|release|set\s+password)\b.*/i;

async function send(srv, line) {
  try {
    await api.Send(srv.cfg.id, line);
  } catch (e) {
    sys(srv, infoBuf(srv), 'error', `Not sent (${e}): ${line.split(' ')[0]}`);
    return;
  }

  const m = /^(PRIVMSG|NOTICE) (\S+) :(.*)$/is.exec(line);
  if (!m) return;
  const notice = m[1].toUpperCase() === 'NOTICE';
  let text = m[3];
  let kind = notice ? 'notice' : 'msg';
  const ctcp = /^\x01(\S+)(?: ([^\x01]*))?\x01?$/.exec(text);

  for (const target of m[2].split(',')) {
    if (ctcp && ctcp[1].toUpperCase() !== 'ACTION') {
      sys(srv, infoBuf(srv), 'info', `CTCP ${ctcp[1].toUpperCase()} sent to ${target}`);
      continue;
    }
    if (ctcp) {
      kind = 'action';
      text = ctcp[2] || '';
    }
    if (/serv$/i.test(target)) text = text.replace(SECRET_RE, (s) => s.split(/\s+/)[0] + ' ********');
    const buf = isChan(srv, target) ? findBuf(srv, target) || infoBuf(srv) : notice ? infoBuf(srv) : getBuf(srv, target, 'query');
    addLine(srv, buf, {kind, from: srv.nick, text: buf.type === 'server' || buf.name !== target ? `→ ${target}: ${text}` : text, self: true});
  }
}

function runResult(srv, res) {
  if (res == null) return;
  if (typeof res === 'string') res = {lines: [res]};
  else if (Array.isArray(res)) res = {lines: res};

  switch (res.action) {
    case 'quit':
      disconnect(srv, res.reason);
      return;
    case 'clear':
      if (S.active) {
        S.active.buf.lines = [];
        dirty('full');
      }
      return;
    case 'close':
      if (S.active) closeBuffer(S.active.srv, S.active.buf);
      return;
    case 'server':
      openServerDialog();
      return;
    case 'palette':
      openPalette();
      return;
    case 'dccsend':
      sendFile(srv, res.nick, res.passive);
      return;
    case 'transfers':
      openTransfers();
      return;
    case 'list':
      srv.list = {items: [], done: false};
      openListDialog(srv);
      break;
  }

  if (res.open) select(srv, getBuf(srv, res.open, isChan(srv, res.open) ? 'channel' : 'query'));
  for (const l of res.lines || []) {
    if (/^QUIT\b/i.test(l)) disconnect(srv, l.replace(/^QUIT\s*:?/i, ''));
    else send(srv, l);
  }
}

function context() {
  const srv = activeSrv();
  const buf = S.active?.buf;
  return {
    srv,
    nick: srv?.nick || '',
    chantypes: srv?.isupport.chantypes || '#&',
    channel: buf?.type === 'channel' ? buf.name : '',
    target: buf && buf.type !== 'server' ? buf.name : '',
  };
}

function submit() {
  const text = ui.input.value;
  if (!text.trim()) return;
  S.history.push(text);
  if (S.history.length > 200) S.history.shift();
  S.histPos = S.history.length;
  ui.input.value = '';
  autosize();

  const ctx = context();
  if (!ctx.srv) {
    toast('Add a server first');
    return;
  }

  if (text.startsWith('/') && !text.startsWith('//')) {
    try {
      runResult(ctx.srv, parseSlash(text.split('\n')[0], ctx));
    } catch (e) {
      sys(ctx.srv, infoBuf(ctx.srv), 'error', e.message);
    }
    return;
  }

  if (!ctx.target) {
    sys(ctx.srv, infoBuf(ctx.srv), 'error', 'This is the server window — use /join #channel, /msg nick text, or /raw.');
    return;
  }
  for (let line of text.split(/\r?\n/)) {
    if (line.startsWith('//')) line = line.slice(1);
    if (!line) continue;
    for (const chunk of utf8Chunks(line)) send(ctx.srv, `PRIVMSG ${ctx.target} :${chunk}`);
  }
}

// ---------- Connections & config ----------

async function saveConfig() {
  S.config.servers = [...S.servers.values()].map((s) => s.cfg);
  try {
    await api.SaveConfig(S.config);
  } catch (e) {
    toast(`Could not save settings: ${e}`);
  }
}

async function connect(srv) {
  try {
    await api.Connect(srv.cfg);
  } catch (e) {
    sys(srv, serverBuf(srv), 'error', String(e));
  }
}

function disconnect(srv, reason) {
  api.Disconnect(srv.cfg.id, reason || 'Leaving');
}

function closeBuffer(srv, buf) {
  if (buf.type === 'server') return;
  if (buf.type === 'channel' && buf.joined) send(srv, `PART ${buf.name}`);
  if (buf.type === 'channel') remember(srv, buf.name, false);
  srv.buffers.delete(lc(buf.name));
  if (isActive(srv, buf)) select(srv, serverBuf(srv));
  dirty('side');
}

function removeServer(srv) {
  if (!confirm(`Remove ${serverName(srv)} and its settings?`)) return;
  disconnect(srv, 'Leaving');
  S.servers.delete(srv.cfg.id);
  if (S.active?.srv === srv) {
    const next = S.servers.values().next().value;
    S.active = null;
    if (next) select(next, serverBuf(next));
  }
  saveConfig();
  dirty('side', 'bar', 'nicks', 'full');
}

// ---------- Modals ----------

function openModal(type, title, body, foot, {wide = false, onBack} = {}) {
  hideMenu();
  ui.modal.className = wide ? 'wide' : '';
  const head = el('div', 'm-head');
  if (onBack) {
    const b = el('button', 'back', '‹');
    b.onclick = onBack;
    head.appendChild(b);
  }
  head.appendChild(el('span', null, title));
  const bodyEl = el('div', 'm-body');
  bodyEl.appendChild(body);
  ui.modal.replaceChildren(head, bodyEl);
  if (foot) ui.modal.appendChild(foot);
  ui.overlay.hidden = false;
  S.modal = {type};
  return S.modal;
}

function closeModal() {
  ui.overlay.hidden = true;
  ui.modal.replaceChildren();
  S.modal = null;
  ui.input.focus();
}

ui.overlay.addEventListener('mousedown', (e) => {
  if (e.target === ui.overlay) closeModal();
});

function footer(buttons) {
  const f = el('div', 'm-foot');
  for (const b of buttons) {
    if (b === '|') {
      f.appendChild(el('span', 'spacer'));
      continue;
    }
    const btn = el('button', b.cls || '', b.label);
    btn.onclick = b.onClick;
    f.appendChild(btn);
  }
  return f;
}

function openPalette(query = '') {
  const wrap = el('div');
  const search = el('input', 'm-search');
  search.placeholder = 'Search IRC commands…';
  search.value = query;
  const list = el('div', 'pal-list');
  wrap.append(search, list);

  let items = [];
  let sel = 0;

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    items = COMMANDS.filter((c) => !q || c.n.toLowerCase().includes(q) || c.d.toLowerCase().includes(q) || c.g.toLowerCase().includes(q));
    sel = Math.min(sel, Math.max(0, items.length - 1));
    const frag = document.createDocumentFragment();
    let group = '';
    items.forEach((c, i) => {
      if (c.g !== group) {
        group = c.g;
        frag.appendChild(el('div', 'pal-group', group));
      }
      const row = el('div', `pal-item${i === sel ? ' sel' : ''}`);
      row.append(el('b', null, c.n), el('span', null, c.d));
      row.onclick = () => openCommandForm(c, search.value);
      frag.appendChild(row);
    });
    if (!items.length) frag.appendChild(el('div', 'muted', 'No matching command. Use RAW to send anything.'));
    list.replaceChildren(frag);
    list.querySelector('.sel')?.scrollIntoView({block: 'nearest'});
  };

  search.oninput = () => {
    sel = 0;
    draw();
  };
  search.onkeydown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(1, items.length);
      draw();
    } else if (e.key === 'Enter' && items[sel]) {
      e.preventDefault();
      openCommandForm(items[sel], search.value);
    }
  };

  openModal('palette', 'IRC commands', wrap);
  draw();
  search.focus();
}

function openCommandForm(cmd, backQuery = '') {
  const ctx = context();
  const form = el('div', 'form');
  const inputs = {};

  for (const fd of cmd.fields) {
    const lab = el('label', null, fd.label + (fd.req ? ' *' : ''));
    let inp;
    if (fd.options) {
      inp = el('select');
      for (const o of fd.options) inp.appendChild(Object.assign(el('option', null, o), {value: o}));
    } else if (fd.long) {
      inp = el('textarea');
    } else {
      inp = el('input');
      inp.type = fd.secret ? 'password' : 'text';
    }
    inp.placeholder = fd.ph || '';
    const def = fd.def?.(ctx);
    if (def) inp.value = def;
    inp.oninput = update;
    inp.onchange = update;
    inputs[fd.k] = inp;
    form.append(lab, inp);
  }

  const preview = el('div', 'preview');
  const err = el('div', 'form-error');
  const wrap = el('div');
  wrap.appendChild(el('div', 'muted', cmd.d));
  wrap.lastChild.style.marginBottom = '12px';
  if (cmd.fields.length) wrap.appendChild(form);
  wrap.append(preview, err);

  function values() {
    const v = {};
    for (const fd of cmd.fields) v[fd.k] = fd.long ? inputs[fd.k].value : inputs[fd.k].value.trim();
    return v;
  }

  function update() {
    const v = values();
    let res;
    try {
      res = cmd.build(v, ctx);
    } catch {
      res = '';
    }
    let text = typeof res === 'string' ? res : Array.isArray(res) ? res.join('\n') : res.action === 'quit' ? `QUIT :${res.reason || 'Leaving'}` : (res.lines || []).join('\n');
    for (const fd of cmd.fields) if (fd.secret && v[fd.k]) text = text.split(v[fd.k]).join('••••••');
    preview.textContent = text || '(nothing to send)';
  }

  function run() {
    const v = values();
    const missing = cmd.fields.find((fd) => fd.req && !v[fd.k]);
    if (missing) {
      err.textContent = `${missing.label} is required`;
      inputs[missing.k].focus();
      return;
    }
    if (!ctx.srv) {
      err.textContent = 'Add and connect a server first';
      return;
    }
    const res = cmd.build(v, ctx);
    closeModal();
    runResult(ctx.srv, res);
  }

  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target.tagName !== 'TEXTAREA' || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      run();
    }
  });

  const foot = footer([{label: 'Cancel', onClick: closeModal}, {label: `Send ${cmd.n}`, cls: 'primary', onClick: run}]);
  openModal('command', cmd.n, wrap, foot, {onBack: () => openPalette(backQuery)});
  update();
  (Object.values(inputs).find((i) => !i.value) || Object.values(inputs)[0])?.focus();
}

function openServerDialog(srv) {
  const c = srv?.cfg || {id: crypto.randomUUID(), name: 'Libera.Chat', host: 'irc.libera.chat', port: 6697, tls: true, nick: '', channels: [], autoConnect: true};
  const form = el('div', 'form');
  const inputs = {};
  const fields = [
    ['name', 'Name', 'text', 'My network'],
    ['host', 'Host *', 'text', 'irc.libera.chat'],
    ['port', 'Port', 'number', '6697'],
    ['tls', 'Use TLS', 'check'],
    ['insecure', 'Accept invalid certificate', 'check'],
    ['nick', 'Nick *', 'text', 'yournick'],
    ['user', 'Username', 'text', 'defaults to nick'],
    ['realname', 'Real name', 'text', 'defaults to nick'],
    ['password', 'Server password', 'password', 'optional (PASS)'],
    ['saslUser', 'SASL account', 'text', 'optional'],
    ['saslPass', 'SASL password', 'password', 'optional'],
    ['channels', 'Auto-join', 'text', '#chan1, #chan2 key'],
    ['dccHost', 'DCC address', 'text', 'optional public IP for sending files'],
    ['autoConnect', 'Connect on startup', 'check'],
  ];

  for (const [k, label, type, ph] of fields) {
    const inp = el('input');
    if (type === 'check') {
      inp.type = 'checkbox';
      inp.checked = !!c[k];
      const lab = el('label', 'check');
      lab.append(inp, document.createTextNode(label));
      form.append(el('span'), lab);
    } else {
      inp.type = type;
      inp.placeholder = ph;
      inp.value = k === 'channels' ? (c.channels || []).join(', ') : (c[k] ?? '');
      form.append(el('label', null, label), inp);
    }
    inputs[k] = inp;
  }
  inputs.tls.onchange = () => {
    if (inputs.port.value === '6667' || inputs.port.value === '6697' || !inputs.port.value) inputs.port.value = inputs.tls.checked ? '6697' : '6667';
  };

  const err = el('div', 'form-error');
  const wrap = el('div');
  wrap.append(form, err);

  const save = async (andConnect) => {
    const cfg = {id: c.id};
    for (const [k, , type] of fields) {
      if (type === 'check') cfg[k] = inputs[k].checked;
      else if (k === 'port') cfg[k] = parseInt(inputs[k].value, 10) || (cfg.tls ? 6697 : 6667);
      else if (k === 'channels') cfg[k] = inputs[k].value.split(',').map((s) => s.trim()).filter(Boolean);
      else cfg[k] = inputs[k].value.trim();
    }
    if (!cfg.host || !cfg.nick) {
      err.textContent = 'Host and nick are required';
      return;
    }
    if (/\s/.test(cfg.nick)) {
      err.textContent = 'Nick cannot contain spaces';
      return;
    }
    let target = srv;
    if (target) {
      target.cfg = cfg;
      if (target.status === 'disconnected') target.nick = cfg.nick;
    } else {
      target = addServer(cfg);
    }
    await saveConfig();
    closeModal();
    select(target, serverBuf(target));
    if (andConnect) connect(target);
  };

  const buttons = [];
  if (srv) buttons.push({label: 'Remove', cls: 'danger', onClick: () => (closeModal(), removeServer(srv))});
  buttons.push('|', {label: 'Cancel', onClick: closeModal}, {label: 'Save', onClick: () => save(false)}, {label: srv ? 'Save & reconnect' : 'Save & connect', cls: 'primary', onClick: () => save(true)});

  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save(true);
    }
  });

  openModal('server', srv ? `Edit ${serverName(srv)}` : 'Add server', wrap, footer(buttons));
  (srv ? inputs.nick : inputs.nick).focus();
}

function openListDialog(srv) {
  if (!srv) return toast('Add a server first');
  const wrap = el('div');
  const tools = el('div', 'list-tools');
  const filter = el('input');
  filter.placeholder = 'Filter by name or topic…';
  const status = el('span', 'muted');
  const refresh = el('button', null, 'Refresh');
  tools.append(filter, status, refresh);
  const table = el('table', 'chanlist');
  const tbody = el('tbody');
  table.appendChild(tbody);
  wrap.append(tools, table);

  const modal = openModal('list', `Channels on ${serverName(srv)}`, wrap, null, {wide: true});

  modal.update = () => {
    const L = srv.list;
    if (!L) {
      status.textContent = '';
      tbody.replaceChildren();
      const td = el('td', 'muted', 'Click Refresh to load the channel list.');
      td.colSpan = 3;
      tbody.appendChild(el('tr')).appendChild(td);
      return;
    }
    const q = filter.value.trim().toLowerCase();
    const rows = (q ? L.items.filter((i) => i.ch.toLowerCase().includes(q) || i.topic.toLowerCase().includes(q)) : L.items.slice()).sort((a, b) => b.n - a.n);
    status.textContent = `${L.done ? '' : 'Loading… '}${rows.length} channel${rows.length === 1 ? '' : 's'}${rows.length > LIST_ROWS ? ` (top ${LIST_ROWS})` : ''}`;
    const frag = document.createDocumentFragment();
    for (const r of rows.slice(0, LIST_ROWS)) {
      const tr = el('tr');
      tr.title = `Join ${r.ch}`;
      tr.append(el('td', null, r.ch), el('td', 'n', r.n), el('td', 't', r.topic));
      tr.onclick = () => {
        closeModal();
        runResult(srv, {open: r.ch, lines: [`JOIN ${r.ch}`]});
      };
      frag.appendChild(tr);
    }
    tbody.replaceChildren(frag);
  };

  filter.oninput = modal.update;
  refresh.onclick = () => {
    srv.list = {items: [], done: false};
    send(srv, 'LIST');
    modal.update();
  };
  modal.update();
  filter.focus();
}

// ---------- Context menus ----------

function showMenu(e, items) {
  e.preventDefault();
  const m = ui.menu;
  m.replaceChildren();
  for (const it of items) {
    if (it === '-') {
      m.appendChild(el('hr'));
      continue;
    }
    const d = el('div', it.danger ? 'danger' : '', it.label);
    d.onclick = () => {
      hideMenu();
      it.run();
    };
    m.appendChild(d);
  }
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(e.clientX, innerWidth - r.width - 8)}px`;
  m.style.top = `${Math.min(e.clientY, innerHeight - r.height - 8)}px`;
}

function hideMenu() {
  ui.menu.hidden = true;
}

function nickMenu(e, srv, nick) {
  const buf = S.active?.buf;
  const ch = buf?.type === 'channel' ? buf.name : '';
  const items = [
    {label: `Message ${nick}`, run: () => select(srv, getBuf(srv, nick, 'query'))},
    {label: 'Whois', run: () => send(srv, `WHOIS ${nick} ${nick}`)},
    {label: 'CTCP Version', run: () => send(srv, `PRIVMSG ${nick} :\x01VERSION\x01`)},
    {label: 'CTCP Ping', run: () => send(srv, `PRIVMSG ${nick} :\x01PING ${Date.now()}\x01`)},
    '-',
    {label: 'Send file…', run: () => sendFile(srv, nick, false)},
    {label: 'Send file (passive)…', run: () => sendFile(srv, nick, true)},
  ];
  if (ch) {
    const mm = (sign, mode) => () => massMode(ch, sign, mode, [nick]).forEach((l) => send(srv, l));
    items.push(
      '-',
      {label: 'Op (+o)', run: mm('+', 'o')},
      {label: 'Deop (-o)', run: mm('-', 'o')},
      {label: 'Voice (+v)', run: mm('+', 'v')},
      {label: 'Devoice (-v)', run: mm('-', 'v')},
      '-',
      {label: 'Kick…', run: () => openCommandForm(withDefaults('KICK', {nick}))},
      {label: 'Ban', danger: true, run: () => send(srv, `MODE ${ch} +b ${banMask(nick)}`)},
      {label: 'Kick + ban…', danger: true, run: () => openCommandForm(withDefaults('KICKBAN', {nick}))},
    );
  }
  showMenu(e, items);
}

function withDefaults(name, values) {
  const c = COMMANDS.find((x) => x.n === name);
  return {...c, fields: c.fields.map((fd) => (values[fd.k] !== undefined ? {...fd, def: () => values[fd.k]} : fd))};
}

function serverMenu(e, srv) {
  const connected = srv.status !== 'disconnected';
  showMenu(e, [
    connected ? {label: 'Disconnect', run: () => disconnect(srv)} : {label: 'Connect', run: () => connect(srv)},
    ...(connected ? [{label: 'Reconnect', run: () => connect(srv)}] : []),
    {label: 'Join channel…', run: () => openCommandForm(withDefaults('JOIN', {}))},
    {label: 'Browse channels…', run: () => openListDialog(srv)},
    {label: 'Edit…', run: () => openServerDialog(srv)},
    '-',
    {label: 'Remove', danger: true, run: () => removeServer(srv)},
  ]);
}

function bufferMenu(e, srv, buf) {
  const items = [];
  if (buf.type === 'channel') {
    items.push(buf.joined ? {label: 'Leave', run: () => send(srv, `PART ${buf.name}`)} : {label: 'Rejoin', run: () => send(srv, `JOIN ${buf.name}`)});
    items.push({label: 'Channel modes', run: () => send(srv, `MODE ${buf.name}`)}, {label: 'Ban list', run: () => send(srv, `MODE ${buf.name} +b`)});
  } else {
    items.push({label: 'Whois', run: () => send(srv, `WHOIS ${buf.name} ${buf.name}`)}, {label: 'Send file…', run: () => sendFile(srv, buf.name, false)}, {label: 'Send file (passive)…', run: () => sendFile(srv, buf.name, true)});
  }
  items.push({label: 'Clear', run: () => ((buf.lines = []), isActive(srv, buf) && dirty('full'))}, '-', {label: buf.type === 'channel' ? 'Leave & close' : 'Close', danger: true, run: () => closeBuffer(srv, buf)});
  showMenu(e, items);
}

function toast(text) {
  const t = el('div', 'toast', text);
  ui.toasts.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// ---------- Input: history, completion, keys ----------

function autosize() {
  ui.input.style.height = 'auto';
  ui.input.style.height = `${Math.min(ui.input.scrollHeight + 2, 160)}px`;
}

let tab = null;
function complete() {
  const inp = ui.input;
  const pos = inp.selectionStart;
  if (!tab || tab.value !== inp.value || tab.pos !== pos) {
    const before = inp.value.slice(0, pos);
    const word = /(\S*)$/.exec(before)[1];
    const ctx = context();
    const start = pos - word.length;
    let cands = [];
    let suffix = ' ';
    if (word.startsWith('/') && start === 0) {
      cands = SLASH_NAMES.map((n) => '/' + n);
    } else if (ctx.srv && isChan(ctx.srv, word)) {
      cands = [...ctx.srv.buffers.values()].filter((b) => b.type === 'channel').map((b) => b.name);
    } else if (ctx.srv) {
      const buf = S.active.buf;
      cands = buf.type === 'channel' ? [...buf.users.values()].map((u) => u.nick) : buf.type === 'query' ? [buf.name] : [];
      if (start === 0) suffix = ': ';
    }
    const w = lc(word);
    cands = cands.filter((c) => lc(c).startsWith(w)).sort((a, b) => (lc(a) < lc(b) ? -1 : 1));
    if (!cands.length) return;
    tab = {cands, i: -1, head: inp.value.slice(0, start), tail: inp.value.slice(pos), suffix};
  }
  tab.i = (tab.i + 1) % tab.cands.length;
  const rep = tab.cands[tab.i] + tab.suffix;
  inp.value = tab.head + rep + tab.tail;
  tab.pos = tab.head.length + rep.length;
  inp.setSelectionRange(tab.pos, tab.pos);
  tab.value = inp.value;
}

ui.input.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    complete();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit();
    return;
  }
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !ui.input.value.includes('\n')) {
    if (!S.history.length) return;
    e.preventDefault();
    S.histPos = Math.max(0, Math.min(S.history.length, S.histPos + (e.key === 'ArrowUp' ? -1 : 1)));
    ui.input.value = S.history[S.histPos] ?? '';
    autosize();
    return;
  }
  if (e.key === 'PageUp' || e.key === 'PageDown') {
    e.preventDefault();
    ui.messages.scrollBy(0, (e.key === 'PageUp' ? -1 : 1) * ui.messages.clientHeight * 0.9);
  }
});
ui.input.addEventListener('input', autosize);

function allBuffers() {
  const out = [];
  for (const srv of S.servers.values()) {
    out.push([srv, serverBuf(srv)]);
    const typeOrder = {channel: 0, query: 1};
    [...srv.buffers.values()]
      .filter((b) => b.type !== 'server')
      .sort((a, b) => typeOrder[a.type] - typeOrder[b.type] || (lc(a.name) < lc(b.name) ? -1 : 1))
      .forEach((b) => out.push([srv, b]));
  }
  return out;
}

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === 'Escape') {
    if (!ui.menu.hidden) hideMenu();
    else if (S.modal) closeModal();
    return;
  }
  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    S.modal?.type === 'palette' ? closeModal() : openPalette();
    return;
  }
  if (S.modal) return;

  if ((e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) || (e.ctrlKey && e.key === 'Tab')) {
    e.preventDefault();
    const list = allBuffers();
    if (!list.length) return;
    const i = list.findIndex(([s, b]) => isActive(s, b));
    const dir = e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1;
    const [s, b] = list[(i + dir + list.length) % list.length];
    select(s, b);
    return;
  }
  if (mod && /^[1-9]$/.test(e.key)) {
    const item = allBuffers()[+e.key - 1];
    if (item) {
      e.preventDefault();
      select(...item);
    }
    return;
  }
  if (!mod && !e.altKey && e.key.length === 1 && document.activeElement !== ui.input && !window.getSelection().toString()) {
    ui.input.focus();
  }
});

document.addEventListener('mousedown', (e) => {
  if (!ui.menu.hidden && !ui.menu.contains(e.target)) hideMenu();
});

// Links open in the system browser; nick clicks insert/mention.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a.link');
  if (a) {
    e.preventDefault();
    rt.BrowserOpenURL(a.dataset.url);
    return;
  }
  const from = e.target.closest('.line .from[data-nick]');
  if (from && !window.getSelection().toString()) {
    const n = from.dataset.nick;
    ui.input.value = ui.input.value ? `${ui.input.value.replace(/\s*$/, ' ')}${n} ` : `${n}: `;
    ui.input.focus();
  }
});

ui.messages.addEventListener('contextmenu', (e) => {
  const from = e.target.closest('.from[data-nick]');
  if (from && S.active) nickMenu(e, S.active.srv, from.dataset.nick);
});
ui.nicks.addEventListener('contextmenu', (e) => {
  const li = e.target.closest('li[data-nick]');
  if (li && S.active) nickMenu(e, S.active.srv, li.dataset.nick);
});
ui.nicks.addEventListener('dblclick', (e) => {
  const li = e.target.closest('li[data-nick]');
  if (li && S.active) select(S.active.srv, getBuf(S.active.srv, li.dataset.nick, 'query'));
});

$('#add-server').onclick = () => openServerDialog();
$('#btn-palette').onclick = () => openPalette();
$('#btn-list').onclick = () => openListDialog(activeSrv());
$('#btn-dcc').onclick = () => openTransfers();
if (!/Mac/.test(navigator.platform)) $('#btn-palette kbd').textContent = 'Ctrl+K';

// ---------- Status bar ----------

const statusEls = Object.fromEntries([...document.querySelectorAll('#statusbar [data-k]')].map((e) => [e.dataset.k, e]));

function stat(k, label, value, level = '') {
  const e = statusEls[k];
  e.className = level;
  e.replaceChildren(document.createTextNode(label ? `${label} ` : ''), el('b', null, value));
}

const fmtUptime = (s) => (s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`);
const level = (v, warn, bad) => (v >= bad ? 'bad' : v >= warn ? 'warn' : '');

async function pollStats() {
  if (document.hidden) return;
  let s;
  try {
    s = await api.Stats();
  } catch {
    return;
  }
  stat('cpu', 'CPU', `${s.cpu.toFixed(1)}%`, level(s.cpu, 25, 60));
  stat('ram', 'RAM', fmtSize(s.rss), level(s.rss, 300 * 2 ** 20, 600 * 2 ** 20));
  stat('heap', 'Heap', fmtSize(s.heap));
  statusEls.heap.title = `Go heap · ${s.goroutines} goroutines`;
  stat('syscpu', 'System CPU', `${s.sysCpu.toFixed(0)}%`, level(s.sysCpu, 70, 90));
  const memPct = s.sysMemTotal ? (s.sysMemUsed / s.sysMemTotal) * 100 : 0;
  stat('sysram', 'System RAM', `${fmtSize(s.sysMemUsed)} / ${fmtSize(s.sysMemTotal)}`, level(memPct, 85, 95));
  stat('net', 'Net', `↓ ${fmtSize(s.netIn)}/s ↑ ${fmtSize(s.netOut)}/s`);

  let connected = 0;
  let channels = 0;
  for (const srv of S.servers.values()) {
    if (srv.status === 'registered') connected++;
    for (const b of srv.buffers.values()) if (b.type === 'channel' && b.joined) channels++;
  }
  stat('irc', '', `${connected}/${S.servers.size} servers · ${channels} channels`);
  stat('up', 'Up', fmtUptime(s.uptime));
}

if (/Mac/.test(navigator.platform)) statusEls.ram.title = 'Memory used by irsee. macOS runs the webview in a separate WebKit process (~50 MB) that is not included here.';
setInterval(pollStats, 2000);
document.addEventListener('visibilitychange', pollStats);
pollStats();

// ---------- Boot ----------

(async function boot() {
  try {
    S.config = await api.LoadConfig();
  } catch (e) {
    toast(`Could not load settings: ${e}`);
  }
  for (const cfg of S.config.servers || []) addServer(cfg);

  const first = S.servers.values().next().value;
  if (first) select(first, serverBuf(first));
  else dirty('full', 'bar', 'side');

  for (const srv of S.servers.values()) if (srv.cfg.autoConnect) connect(srv);
  if (!first) openServerDialog();
})();
