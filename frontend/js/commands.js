// Catalog of IRC commands for the GUI palette, plus the /slash command parser.
// A builder returns a raw line, an array of raw lines, or {lines, open, action}.

const f = (k, label, opts = {}) => ({k, label, ...opts});
const chan = (req = true) => f('channel', 'Channel', {ph: '#channel', req, def: (c) => c.channel});
const target = () => f('target', 'Target', {ph: '#channel or nick', req: true, def: (c) => c.target});
const nickF = (label = 'Nick', req = true) => f('nick', label, {ph: 'nick', req});
const opt = (v, pre = ' ') => (v ? pre + v : '');
const ctcp = (to, cmd, args) => `PRIVMSG ${to} :\x01${cmd.toUpperCase()}${opt(args)}\x01`;
const words = (s) => (s || '').split(/[\s,]+/).filter(Boolean);

export function massMode(channel, sign, mode, nicks, per = 3) {
  const lines = [];
  for (let i = 0; i < nicks.length; i += per) {
    const chunk = nicks.slice(i, i + per);
    lines.push(`MODE ${channel} ${sign}${mode.repeat(chunk.length)} ${chunk.join(' ')}`);
  }
  return lines;
}

export const banMask = (v) => (/[!@*]/.test(v) ? v : `${v}!*@*`);

const mm = (sign, mode) => (v) => massMode(v.channel, sign, mode, words(v.nicks));
const nicksF = () => f('nicks', 'Nicks', {ph: 'nick1 nick2 ...', req: true});

export const COMMANDS = [
  // Messaging
  {g: 'Messaging', n: 'PRIVMSG', d: 'Send a message to a channel or user', fields: [target(), f('text', 'Message', {req: true, long: true})], build: (v) => `PRIVMSG ${v.target} :${v.text}`},
  {g: 'Messaging', n: 'ACTION', d: 'Send an action (/me)', fields: [target(), f('text', 'Action', {req: true})], build: (v) => ctcp(v.target, 'ACTION', v.text)},
  {g: 'Messaging', n: 'NOTICE', d: 'Send a notice', fields: [target(), f('text', 'Notice', {req: true})], build: (v) => `NOTICE ${v.target} :${v.text}`},
  {g: 'Messaging', n: 'QUERY', d: 'Open a private conversation', fields: [nickF(), f('text', 'First message')], build: (v) => ({open: v.nick, lines: v.text ? [`PRIVMSG ${v.nick} :${v.text}`] : []})},

  // Channel
  {g: 'Channel', n: 'JOIN', d: 'Join a channel', fields: [f('channel', 'Channel', {ph: '#channel', req: true}), f('key', 'Key', {ph: 'optional'})], build: (v) => ({open: v.channel.split(',')[0], lines: [`JOIN ${v.channel}${opt(v.key)}`]})},
  {g: 'Channel', n: 'PART', d: 'Leave a channel', fields: [chan(), f('reason', 'Reason')], build: (v) => `PART ${v.channel}${opt(v.reason, ' :')}`},
  {g: 'Channel', n: 'CYCLE', d: 'Leave and rejoin a channel', fields: [chan()], build: (v) => [`PART ${v.channel} :Cycling`, `JOIN ${v.channel}`]},
  {g: 'Channel', n: 'TOPIC', d: 'View or change the topic (leave empty to view)', fields: [chan(), f('topic', 'New topic', {long: true})], build: (v) => (v.topic ? `TOPIC ${v.channel} :${v.topic}` : `TOPIC ${v.channel}`)},
  {g: 'Channel', n: 'NAMES', d: 'List users in a channel', fields: [chan()], build: (v) => `NAMES ${v.channel}`},
  {g: 'Channel', n: 'LIST', d: 'Browse channels on the server', fields: [f('mask', 'Filter', {ph: 'optional, e.g. >50 or *linux*'})], build: (v) => ({action: 'list', lines: [`LIST${opt(v.mask)}`]})},
  {g: 'Channel', n: 'INVITE', d: 'Invite a user to a channel', fields: [nickF(), chan()], build: (v) => `INVITE ${v.nick} ${v.channel}`},
  {g: 'Channel', n: 'KNOCK', d: 'Ask to be invited to an invite-only channel', fields: [chan(), f('text', 'Message')], build: (v) => `KNOCK ${v.channel}${opt(v.text, ' :')}`},
  {g: 'Channel', n: 'MODE (channel)', d: 'View or set channel modes', fields: [chan(), f('modes', 'Modes', {ph: '+nt, +k key, +l 50 ...'}), f('args', 'Arguments')], build: (v) => `MODE ${v.channel}${opt(v.modes)}${opt(v.args)}`},
  {g: 'Channel', n: 'KICK', d: 'Kick a user from a channel', fields: [chan(), nickF(), f('reason', 'Reason')], build: (v) => `KICK ${v.channel} ${v.nick}${opt(v.reason, ' :')}`},
  {g: 'Channel', n: 'BAN', d: 'Ban a nick or mask', fields: [chan(), f('mask', 'Nick or mask', {req: true})], build: (v) => `MODE ${v.channel} +b ${banMask(v.mask)}`},
  {g: 'Channel', n: 'UNBAN', d: 'Remove a ban', fields: [chan(), f('mask', 'Nick or mask', {req: true})], build: (v) => `MODE ${v.channel} -b ${banMask(v.mask)}`},
  {g: 'Channel', n: 'KICKBAN', d: 'Ban then kick a user', fields: [chan(), nickF(), f('reason', 'Reason')], build: (v) => [`MODE ${v.channel} +b ${banMask(v.nick)}`, `KICK ${v.channel} ${v.nick}${opt(v.reason, ' :')}`]},
  {g: 'Channel', n: 'BANLIST', d: 'Show ban list (+b)', fields: [chan()], build: (v) => `MODE ${v.channel} +b`},
  {g: 'Channel', n: 'EXCEPTLIST', d: 'Show ban exceptions (+e)', fields: [chan()], build: (v) => `MODE ${v.channel} +e`},
  {g: 'Channel', n: 'INVITELIST', d: 'Show invite exceptions (+I)', fields: [chan()], build: (v) => `MODE ${v.channel} +I`},
  {g: 'Channel', n: 'OP', d: 'Give operator (+o)', fields: [chan(), nicksF()], build: mm('+', 'o')},
  {g: 'Channel', n: 'DEOP', d: 'Remove operator (-o)', fields: [chan(), nicksF()], build: mm('-', 'o')},
  {g: 'Channel', n: 'HALFOP', d: 'Give half-operator (+h)', fields: [chan(), nicksF()], build: mm('+', 'h')},
  {g: 'Channel', n: 'DEHALFOP', d: 'Remove half-operator (-h)', fields: [chan(), nicksF()], build: mm('-', 'h')},
  {g: 'Channel', n: 'VOICE', d: 'Give voice (+v)', fields: [chan(), nicksF()], build: mm('+', 'v')},
  {g: 'Channel', n: 'DEVOICE', d: 'Remove voice (-v)', fields: [chan(), nicksF()], build: mm('-', 'v')},

  // User
  {g: 'User', n: 'NICK', d: 'Change your nickname', fields: [f('nick', 'New nick', {req: true, def: (c) => c.nick})], build: (v) => `NICK ${v.nick}`},
  {g: 'User', n: 'AWAY', d: 'Set away message (empty = back)', fields: [f('text', 'Message')], build: (v) => `AWAY${opt(v.text, ' :')}`},
  {g: 'User', n: 'WHOIS', d: 'Information about a user', fields: [nickF()], build: (v) => `WHOIS ${v.nick} ${v.nick}`},
  {g: 'User', n: 'WHOWAS', d: 'Information about a past nick', fields: [nickF(), f('count', 'Count')], build: (v) => `WHOWAS ${v.nick}${opt(v.count)}`},
  {g: 'User', n: 'WHO', d: 'Search users by mask or channel', fields: [f('mask', 'Mask', {req: true, def: (c) => c.channel})], build: (v) => `WHO ${v.mask}`},
  {g: 'User', n: 'ISON', d: 'Check which nicks are online', fields: [nicksF()], build: (v) => `ISON ${words(v.nicks).join(' ')}`},
  {g: 'User', n: 'USERHOST', d: 'Get user@host of up to 5 nicks', fields: [nicksF()], build: (v) => `USERHOST ${words(v.nicks).slice(0, 5).join(' ')}`},
  {g: 'User', n: 'MONITOR', d: 'Watch nicks for online/offline (IRCv3)', fields: [f('op', 'Action', {req: true, options: ['+', '-', 'C', 'L', 'S'], def: () => '+'}), f('nicks', 'Nicks', {ph: 'for + and -'})], build: (v) => `MONITOR ${v.op}${opt(words(v.nicks).join(','))}`},
  {g: 'User', n: 'MODE (user)', d: 'View or set your user modes', fields: [f('modes', 'Modes', {ph: '+i, -w ...'})], build: (v, c) => `MODE ${c.nick}${opt(v.modes)}`},
  {g: 'User', n: 'SETNAME', d: 'Change your real name (IRCv3)', fields: [f('text', 'Real name', {req: true})], build: (v) => `SETNAME :${v.text}`},

  // Server info
  {g: 'Server', n: 'MOTD', d: 'Message of the day', fields: [f('server', 'Server')], build: (v) => `MOTD${opt(v.server)}`},
  {g: 'Server', n: 'LUSERS', d: 'Network size statistics', fields: [], build: () => 'LUSERS'},
  {g: 'Server', n: 'VERSION', d: 'Server software version', fields: [f('server', 'Server')], build: (v) => `VERSION${opt(v.server)}`},
  {g: 'Server', n: 'STATS', d: 'Server statistics', fields: [f('query', 'Query', {req: true, ph: 'u, l, m, o, k ...'}), f('server', 'Server')], build: (v) => `STATS ${v.query}${opt(v.server)}`},
  {g: 'Server', n: 'LINKS', d: 'List linked servers', fields: [f('mask', 'Mask')], build: (v) => `LINKS${opt(v.mask)}`},
  {g: 'Server', n: 'TIME', d: 'Server local time', fields: [f('server', 'Server')], build: (v) => `TIME${opt(v.server)}`},
  {g: 'Server', n: 'ADMIN', d: 'Server administrator info', fields: [f('server', 'Server')], build: (v) => `ADMIN${opt(v.server)}`},
  {g: 'Server', n: 'INFO', d: 'Server information', fields: [f('server', 'Server')], build: (v) => `INFO${opt(v.server)}`},
  {g: 'Server', n: 'HELP', d: 'Server help topics', fields: [f('topic', 'Topic')], build: (v) => `HELP${opt(v.topic)}`},
  {g: 'Server', n: 'QUIT', d: 'Disconnect from this server', fields: [f('reason', 'Reason')], build: (v) => ({action: 'quit', reason: v.reason})},
  {g: 'Server', n: 'RAW', d: 'Send any raw IRC line', fields: [f('line', 'Line', {req: true, ph: 'COMMAND params :trailing'})], build: (v) => v.line},

  // Operator
  {g: 'Operator', n: 'OPER', d: 'Become an IRC operator', fields: [f('name', 'Name', {req: true}), f('password', 'Password', {req: true, secret: true})], build: (v) => `OPER ${v.name} ${v.password}`},
  {g: 'Operator', n: 'KILL', d: 'Disconnect a user from the network', fields: [nickF(), f('reason', 'Reason', {req: true})], build: (v) => `KILL ${v.nick} :${v.reason}`},
  {g: 'Operator', n: 'WALLOPS', d: 'Message all operators', fields: [f('text', 'Message', {req: true})], build: (v) => `WALLOPS :${v.text}`},
  {g: 'Operator', n: 'REHASH', d: 'Reload server config', fields: [], build: () => 'REHASH'},
  {g: 'Operator', n: 'RESTART', d: 'Restart the server', fields: [], build: () => 'RESTART'},
  {g: 'Operator', n: 'DIE', d: 'Shut the server down', fields: [], build: () => 'DIE'},
  {g: 'Operator', n: 'CONNECT', d: 'Link a server', fields: [f('server', 'Target server', {req: true}), f('port', 'Port'), f('remote', 'Remote server')], build: (v) => `CONNECT ${v.server}${opt(v.port)}${opt(v.remote)}`},
  {g: 'Operator', n: 'SQUIT', d: 'Unlink a server', fields: [f('server', 'Server', {req: true}), f('reason', 'Reason', {req: true})], build: (v) => `SQUIT ${v.server} :${v.reason}`},
  {g: 'Operator', n: 'TRACE', d: 'Trace route to a server or user', fields: [f('target', 'Target')], build: (v) => `TRACE${opt(v.target)}`},

  // Services
  {g: 'Services', n: 'NickServ IDENTIFY', d: 'Log in to your account', fields: [f('account', 'Account'), f('password', 'Password', {req: true, secret: true})], build: (v) => `PRIVMSG NickServ :IDENTIFY${opt(v.account)} ${v.password}`},
  {g: 'Services', n: 'NickServ REGISTER', d: 'Register your current nick', fields: [f('password', 'Password', {req: true, secret: true}), f('email', 'Email', {req: true})], build: (v) => `PRIVMSG NickServ :REGISTER ${v.password} ${v.email}`},
  {g: 'Services', n: 'NickServ REGAIN', d: 'Take back your nick', fields: [nickF(), f('password', 'Password', {secret: true})], build: (v) => `PRIVMSG NickServ :REGAIN ${v.nick}${opt(v.password)}`},
  {g: 'Services', n: 'NickServ INFO', d: 'Account info', fields: [nickF('Nick or account')], build: (v) => `PRIVMSG NickServ :INFO ${v.nick}`},
  {g: 'Services', n: 'ChanServ OP', d: 'Ask ChanServ for op', fields: [chan(), nickF('Nick', false)], build: (v) => `PRIVMSG ChanServ :OP ${v.channel}${opt(v.nick)}`},
  {g: 'Services', n: 'ChanServ REGISTER', d: 'Register a channel', fields: [chan()], build: (v) => `PRIVMSG ChanServ :REGISTER ${v.channel}`},
  {g: 'Services', n: 'ChanServ INFO', d: 'Channel registration info', fields: [chan()], build: (v) => `PRIVMSG ChanServ :INFO ${v.channel}`},
  {g: 'Services', n: 'Services command', d: 'Any NickServ / ChanServ / other service command', fields: [f('service', 'Service', {req: true, options: ['NickServ', 'ChanServ', 'MemoServ', 'OperServ', 'HostServ', 'BotServ']}), f('text', 'Command', {req: true})], build: (v) => `PRIVMSG ${v.service} :${v.text}`},

  // Files
  {g: 'Files', n: 'DCC SEND', d: 'Send a file directly to a user', fields: [f('nick', 'Nick', {req: true, def: (c) => (c.target && !c.channel ? c.target : '')}), f('mode', 'Mode', {options: ['active', 'passive'], def: () => 'active'})], build: (v) => ({action: 'dccsend', nick: v.nick, passive: v.mode === 'passive'})},
  {g: 'Files', n: 'DCC transfers', d: 'Show incoming and outgoing file transfers', fields: [], build: () => ({action: 'transfers'})},

  // CTCP
  {g: 'CTCP', n: 'CTCP', d: 'Client-to-client query', fields: [target(), f('cmd', 'Query', {req: true, options: ['VERSION', 'PING', 'TIME', 'CLIENTINFO', 'SOURCE', 'USERINFO']}), f('args', 'Arguments')], build: (v) => ctcp(v.target, v.cmd, v.cmd === 'PING' && !v.args ? String(Date.now()) : v.args)},
];

// Slash commands: /name args. Unknown ones are sent as raw IRC commands.
export function parseSlash(input, c) {
  const toks = [...input.slice(1).matchAll(/\S+/g)];
  if (!toks.length) return null;
  const cmd = toks[0][0].toLowerCase();
  const a = toks.slice(1).map((t) => t[0]);
  const rest = (i) => (toks[i + 2] ? input.slice(1).slice(toks[i + 2].index) : '');
  const isChan = (s) => !!s && c.chantypes.includes(s[0]);
  const need = (cond, usage) => {
    if (!cond) throw new Error(`Usage: ${usage}`);
  };
  const chanArg = () => (isChan(a[0]) ? [a[0], 1] : [c.channel, 0]);

  switch (cmd) {
    case 'j':
    case 'join': {
      need(a[0], '/join #channel [key]');
      const ch = isChan(a[0]) ? a[0] : '#' + a[0];
      return {open: ch.split(',')[0], lines: [`JOIN ${ch}${opt(a[1])}`]};
    }
    case 'part':
    case 'leave': {
      const [ch, i] = chanArg();
      need(ch, '/part [#channel] [reason]');
      return `PART ${ch}${opt(rest(i - 1), ' :')}`;
    }
    case 'cycle':
    case 'rejoin': {
      const [ch] = chanArg();
      need(ch, '/cycle [#channel]');
      return [`PART ${ch} :Cycling`, `JOIN ${ch}`];
    }
    case 'msg':
    case 'privmsg':
      need(a[0] && a[1], '/msg target message');
      return `PRIVMSG ${a[0]} :${rest(0)}`;
    case 'q':
    case 'query':
      need(a[0], '/query nick [message]');
      return {open: a[0], lines: a[1] ? [`PRIVMSG ${a[0]} :${rest(0)}`] : []};
    case 'me':
      need(c.target && a[0], '/me action (in a channel or query)');
      return ctcp(c.target, 'ACTION', rest(-1));
    case 'notice':
      need(a[0] && a[1], '/notice target message');
      return `NOTICE ${a[0]} :${rest(0)}`;
    case 'nick':
      need(a[0], '/nick newnick');
      return `NICK ${a[0]}`;
    case 'topic': {
      const [ch, i] = chanArg();
      need(ch, '/topic [#channel] [new topic]');
      const t = rest(i - 1);
      return t ? `TOPIC ${ch} :${t}` : `TOPIC ${ch}`;
    }
    case 'kick':
    case 'k': {
      const [ch, i] = chanArg();
      need(ch && a[i], '/kick [#channel] nick [reason]');
      return `KICK ${ch} ${a[i]}${opt(rest(i), ' :')}`;
    }
    case 'kb':
    case 'kickban': {
      const [ch, i] = chanArg();
      need(ch && a[i], '/kickban [#channel] nick [reason]');
      return [`MODE ${ch} +b ${banMask(a[i])}`, `KICK ${ch} ${a[i]}${opt(rest(i), ' :')}`];
    }
    case 'ban':
    case 'unban': {
      const [ch, i] = chanArg();
      need(ch && a[i], `/${cmd} [#channel] nick|mask`);
      return `MODE ${ch} ${cmd === 'ban' ? '+' : '-'}b ${banMask(a[i])}`;
    }
    case 'op':
    case 'deop':
    case 'voice':
    case 'devoice':
    case 'halfop':
    case 'dehalfop': {
      const [ch, i] = chanArg();
      need(ch && a[i], `/${cmd} [#channel] nick [nick ...]`);
      const mode = {op: 'o', voice: 'v', halfop: 'h'}[cmd.replace(/^de/, '')];
      return massMode(ch, cmd.startsWith('de') ? '-' : '+', mode, a.slice(i));
    }
    case 'mode':
    case 'm': {
      if (!a[0]) return c.channel ? `MODE ${c.channel}` : `MODE ${c.nick}`;
      if (isChan(a[0]) || a[0].toLowerCase() === c.nick.toLowerCase()) return `MODE ${rest(-1)}`;
      need(c.channel, '/mode [target] modes [args]');
      return `MODE ${c.channel} ${rest(-1)}`;
    }
    case 'invite':
      need(a[0] && (a[1] || c.channel), '/invite nick [#channel]');
      return `INVITE ${a[0]} ${a[1] || c.channel}`;
    case 'whois':
    case 'wi':
      need(a[0], '/whois nick');
      return `WHOIS ${a[0]} ${a[0]}`;
    case 'away':
      return `AWAY${opt(rest(-1), ' :')}`;
    case 'back':
      return 'AWAY';
    case 'list':
      return {action: 'list', lines: [`LIST${opt(rest(-1))}`]};
    case 'ctcp':
      need(a[0] && a[1], '/ctcp target command [args]');
      return ctcp(a[0], a[1], a[1].toUpperCase() === 'PING' && !a[2] ? String(Date.now()) : rest(1));
    case 'ns':
    case 'cs':
    case 'ms':
    case 'os':
    case 'hs':
    case 'bs': {
      need(a[0], `/${cmd} command`);
      const svc = {ns: 'NickServ', cs: 'ChanServ', ms: 'MemoServ', os: 'OperServ', hs: 'HostServ', bs: 'BotServ'}[cmd];
      return `PRIVMSG ${svc} :${rest(-1)}`;
    }
    case 'dcc': {
      const sub = (a[0] || '').toLowerCase();
      if (sub === 'send' || sub === 'psend') {
        need(a[1], '/dcc send|psend nick');
        return {action: 'dccsend', nick: a[1], passive: sub === 'psend'};
      }
      return {action: 'transfers'};
    }
    case 'quit':
    case 'disconnect':
      return {action: 'quit', reason: rest(-1)};
    case 'raw':
    case 'quote':
      need(a[0], '/raw LINE');
      return rest(-1);
    case 'clear':
      return {action: 'clear'};
    case 'close':
      return {action: 'close'};
    case 'server':
    case 'connect':
      return {action: 'server'};
    case 'help':
    case 'commands':
      return {action: 'palette'};
    default:
      return `${cmd.toUpperCase()}${opt(rest(-1))}`;
  }
}

export const SLASH_NAMES = ['join', 'part', 'cycle', 'msg', 'query', 'me', 'notice', 'nick', 'topic', 'kick', 'kickban', 'ban', 'unban', 'op', 'deop', 'voice', 'devoice', 'halfop', 'dehalfop', 'mode', 'invite', 'whois', 'who', 'whowas', 'away', 'back', 'list', 'ctcp', 'ns', 'cs', 'quit', 'raw', 'clear', 'close', 'server', 'help', 'motd', 'names', 'oper', 'knock', 'monitor', 'dcc'];
