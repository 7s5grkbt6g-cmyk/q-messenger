const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'db.json');
const CHANNELS = ['general', 'gaming', 'random'];

fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { users: {}, friends: {}, messages: [] };
  }
}

let db = loadDb();
let saveTimer = null;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(db, null, 2), () => {});
  }, 200);
}

function hashPass(pass, salt) {
  return crypto.scryptSync(pass, salt, 32).toString('hex');
}
function uid() {
  return crypto.randomBytes(8).toString('hex');
}
function friendKey(a, b) {
  return [a, b].sort().join('|');
}

const tokens = new Map(); // token -> username
const online = new Map(); // username -> Set(socketId)
const typingUntil = new Map();

function publicUser(name) {
  const u = db.users[name];
  return {
    username: name,
    color: u.color,
    createdAt: u.createdAt,
    online: online.has(name),
  };
}
function friendsOf(name) {
  const out = [];
  for (const [key, f] of Object.entries(db.friends)) {
    if (key.split('|').includes(name) && f.status === 'accepted') {
      const other = key.split('|').find((n) => n !== name);
      if (db.users[other]) out.push(publicUser(other));
    }
  }
  return out;
}
function incomingRequests(name) {
  return Object.entries(db.friends)
    .filter(([key, f]) => f.status === 'pending' && f.from !== name && key.split('|').includes(name))
    .map(([key, f]) => ({ user: publicUser(f.from) }));
}
function outgoingRequests(name) {
  return Object.entries(db.friends)
    .filter(([key, f]) => f.status === 'pending' && f.from === name && key.split('|').includes(name))
    .map(([key, f]) => ({ user: publicUser(f.to) }));
}
function dmHistory(a, b, limit = 200) {
  const key = friendKey(a, b);
  return db.messages.filter((m) => m.dm === key).slice(-limit);
}
function channelHistory(ch, limit = 200) {
  return db.messages.filter((m) => m.channel === ch).slice(-limit);
}

// ---------- HTTP API ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const t = req.headers['authorization']?.replace('Bearer ', '');
  const user = tokens.get(t);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  next();
}

app.post('/api/register', (req, res) => {
  let { username, password } = req.body || {};
  username = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9_.-]{2,20}$/.test(username))
    return res.status(400).json({ error: 'Имя: 2–20 символов (латиница, цифры, _ . -)' });
  if (!password || String(password).length < 4)
    return res.status(400).json({ error: 'Пароль минимум 4 символа' });
  if (db.users[username]) return res.status(400).json({ error: 'Имя уже занято' });
  const salt = crypto.randomBytes(8).toString('hex');
  const palette = ['#7c3aed', '#a855f7', '#c084fc', '#8b5cf6', '#6d28d9', '#9333ea', '#7e22ce'];
  db.users[username] = {
    salt,
    pass: hashPass(String(password), salt),
    color: palette[crypto.randomInt(palette.length)],
    createdAt: Date.now(),
  };
  saveDb();
  const token = uid() + uid();
  tokens.set(token, username);
  res.json({ token, username });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.users[String(username || '').trim().toLowerCase()];
  if (!u || hashPass(String(password || ''), u.salt) !== u.pass)
    return res.status(401).json({ error: 'Неверное имя или пароль' });
  const name = String(username).trim().toLowerCase();
  const token = uid() + uid();
  tokens.set(token, name);
  res.json({ token, username: name });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.get('/api/state', auth, (req, res) => {
  const me = req.user;
  res.json({
    me: publicUser(me),
    channels: CHANNELS,
    friends: friendsOf(me),
    incoming: incomingRequests(me),
    outgoing: outgoingRequests(me),
    unread: db.users[me].unread || {},
  });
});

app.post('/api/friends/add', auth, (req, res) => {
  const target = String(req.body?.username || '').trim().toLowerCase();
  const me = req.user;
  if (target === me) return res.status(400).json({ error: 'Себя нельзя добавить' });
  if (!db.users[target]) return res.status(400).json({ error: 'Пользователь не найден' });
  const key = friendKey(me, target);
  if (db.friends[key]) return res.status(400).json({ error: 'Заявка уже отправлена' });
  db.friends[key] = { from: me, to: target, status: 'pending', since: Date.now() };
  saveDb();
  io.to('u:' + target).emit('friend:request', { user: publicUser(me) });
  res.json({ ok: true });
});

app.post('/api/friends/respond', auth, (req, res) => {
  const other = String(req.body?.username || '').trim().toLowerCase();
  const me = req.user;
  const key = friendKey(me, other);
  const f = db.friends[key];
  if (!f || f.status !== 'pending' || f.to !== me)
    return res.status(400).json({ error: 'Заявка не найдена' });
  if (req.body?.accept) {
    f.status = 'accepted';
    saveDb();
    io.to('u:' + other).emit('friend:accepted', { user: publicUser(me) });
    res.json({ ok: true });
  } else {
    delete db.friends[key];
    saveDb();
    io.to('u:' + other).emit('friend:declined', { user: publicUser(me) });
    res.json({ ok: true });
  }
});

app.delete('/api/friends/remove', auth, (req, res) => {
  const other = String(req.body?.username || '').trim().toLowerCase();
  delete db.friends[friendKey(req.user, other)];
  saveDb();
  io.to('u:' + other).emit('friend:removed', { user: publicUser(req.user) });
  res.json({ ok: true });
});

app.get('/api/search', auth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ results: [] });
  const me = req.user;
  const results = Object.keys(db.users)
    .filter(
      (n) =>
        n !== me &&
        n.includes(q) &&
        !db.friends[friendKey(me, n)]
    )
    .slice(0, 8)
    .map(publicUser);
  res.json({ results });
});

app.get('/api/users', auth, (req, res) => {
  res.json({ users: Object.keys(db.users).map(publicUser) });
});

app.get('/api/messages', auth, (req, res) => {
  const me = req.user;
  if (req.query.channel && CHANNELS.includes(req.query.channel))
    return res.json({ messages: channelHistory(req.query.channel) });
  if (req.query.with && db.users[req.query.with]) {
    const unread = db.users[me].unread || {};
    delete unread['dm:' + req.query.with];
    saveDb();
    return res.json({ messages: dmHistory(me, req.query.with) });
  }
  res.status(400).json({ error: 'bad query' });
});

// ---------- WebSocket ----------
const server = http.createServer(app);
const io = new Server(server);

io.use((socket, next) => {
  const user = tokens.get(socket.handshake.auth.token);
  if (!user) return next(new Error('unauthorized'));
  socket.user = user;
  next();
});

io.on('connection', (socket) => {
  const me = socket.user;
  socket.join('u:' + me);
  CHANNELS.forEach((c) => socket.join('ch:' + c));
  friendsOf(me).forEach((f) => socket.join('dm:' + friendKey(me, f.username)));
  if (!online.has(me)) online.set(me, new Set());
  online.get(me).add(socket.id);
  io.emit('presence', { username: me, online: true });

  socket.on('dm:open', (other) => {
    if (db.users[other]) socket.join('dm:' + friendKey(me, other));
  });

  socket.on('typing', (target) => {
    // target: "ch:name" or "dm:name"
    const room = target.startsWith('ch:')
      ? 'ch:' + target.slice(3)
      : 'dm:' + friendKey(me, target.slice(3));
    socket.to(room).emit('typing', { from: me, target });
    if (target.startsWith('dm:')) {
      typingUntil.set(friendKey(me, target.slice(3)) + ':' + me, Date.now() + 3000);
    }
  });

  socket.on('message:send', (payload, cb) => {
    let text = String(payload?.text || '').trim().slice(0, 2000);
    if (!text) return;
    const msg = { id: uid(), author: me, text, ts: Date.now() };
    if (payload.channel && CHANNELS.includes(payload.channel)) {
      msg.channel = payload.channel;
      io.to('ch:' + msg.channel).emit('chat:message', msg);
    } else if (payload.to && db.users[payload.to] && friendsOf(me).some((f) => f.username === payload.to)) {
      msg.dm = friendKey(me, payload.to);
      io.to('u:' + me).to('u:' + payload.to).emit('chat:message', msg);
      const other = db.users[payload.to];
      other.unread = other.unread || {};
      const onlineSockets = online.get(payload.to);
      // count unread unless they currently view this dm (socket in room handled client-side; simple: if offline)
      if (!onlineSockets || onlineSockets.size === 0) {
        other.unread['dm:' + me] = (other.unread['dm:' + me] || 0) + 1;
        io.to('u:' + payload.to).emit('unread', { key: 'dm:' + me, count: other.unread['dm:' + me] });
      }
    } else {
      return;
    }
    db.messages.push(msg);
    if (db.messages.length > 5000) db.messages = db.messages.slice(-4000);
    saveDb();
    cb && cb({ ok: true, id: msg.id, ts: msg.ts });
  });

  socket.on('disconnect', () => {
    const set = online.get(me);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) {
        online.delete(me);
        io.emit('presence', { username: me, online: false });
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Q-Messenger запущен: http://localhost:${PORT}`);
});
