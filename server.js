const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'db.json');
const CHANNELS = ['general', 'gaming', 'random'];

// SMTP для кодов подтверждения (Gmail: SMTP_USER=адрес, SMTP_PASS=пароль приложения)
const SMTP = process.env.SMTP_USER && process.env.SMTP_PASS
  ? require('nodemailer').createTransport({
      service: process.env.SMTP_SERVICE || 'gmail',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

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
function key(a, b) {
  return [a, b].sort().join('|');
}
const normEmail = (e) => String(e || '').trim().toLowerCase();
const normName = (n) => String(n || '').trim().toLowerCase();

function userByEmail(email) {
  return db.users[email];
}
function userByName(name) {
  return Object.values(db.users).find((u) => u.username === normName(name));
}
function findUser(id) {
  return userByEmail(normEmail(id)) || userByName(id);
}

function publicUser(email) {
  const u = db.users[email];
  return {
    email,
    username: u.username,
    color: u.color,
    createdAt: u.createdAt,
    online: online.has(email),
  };
}
function friendsOf(email) {
  const out = [];
  for (const [k, f] of Object.entries(db.friends)) {
    if (k.split('|').includes(email) && f.status === 'accepted') {
      const other = k.split('|').find((e) => e !== email);
      if (db.users[other]) out.push(publicUser(other));
    }
  }
  return out;
}
function requestsOf(email, dir) {
  return Object.entries(db.friends)
    .filter(([k, f]) => {
      if (f.status !== 'pending' || !k.split('|').includes(email)) return false;
      return dir === 'in' ? f.to === email : f.from === email;
    })
    .map(([, f]) => ({ user: publicUser(dir === 'in' ? f.from : f.to) }));
}
function dmHistory(a, b, limit = 200) {
  const k = key(a, b);
  return db.messages.filter((m) => m.dm === k).slice(-limit);
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
  const email = tokens.get(t);
  if (!email) return res.status(401).json({ error: 'unauthorized' });
  req.email = email;
  next();
}

async function sendCode(email, code) {
  await SMTP.sendMail({
    from: `"Q-Messenger" <${process.env.SMTP_USER}>`,
    to: email,
    subject: 'Код подтверждения Q-Messenger',
    text: `Твой код подтверждения: ${code}\nДействителен 15 минут.`,
  });
}

function issueToken(email) {
  const token = uid() + uid();
  tokens.set(token, email);
  return token;
}

app.post('/api/register', async (req, res) => {
  const email = normEmail(req.body?.email);
  let username = normName(req.body?.username) || email.split('@')[0];
  const password = String(req.body?.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
    return res.status(400).json({ error: 'Введите корректный email' });
  if (!/^[a-z0-9_.-]{2,20}$/.test(username))
    return res.status(400).json({ error: 'Имя: 2–20 символов (латиница, цифры, _ . -)' });
  if (password.length < 4) return res.status(400).json({ error: 'Пароль минимум 4 символа' });
  if (db.users[email]) return res.status(400).json({ error: 'Этот email уже зарегистрирован' });
  if (Object.values(db.users).some((u) => u.username === username))
    return res.status(400).json({ error: 'Такое имя уже занято' });
  const salt = crypto.randomBytes(8).toString('hex');
  const palette = ['#3390ec', '#e17076', '#7bc862', '#a695e7', '#ee7aae', '#6ec9cb', '#faa774', '#5ca6ea'];
  const user = {
    email,
    username,
    salt,
    pass: hashPass(password, salt),
    color: palette[crypto.randomInt(palette.length)],
    createdAt: Date.now(),
    verified: !SMTP,
    unread: {},
  };
  db.users[email] = user;
  if (SMTP) {
    const code = String(crypto.randomInt(100000, 999999));
    user.code = crypto.createHash('sha256').update(code).digest('hex');
    user.codeExp = Date.now() + 15 * 60 * 1000;
    try {
      await sendCode(email, code);
    } catch (e) {
      delete db.users[email];
      return res.status(502).json({ error: 'Не удалось отправить письмо: ' + e.message });
    }
    saveDb();
    return res.json({ needVerify: true, email });
  }
  saveDb();
  res.json({ token: issueToken(email), username });
});

app.post('/api/resend', async (req, res) => {
  if (!SMTP) return res.status(400).json({ error: 'Проверка почты не настроена' });
  const email = normEmail(req.body?.email);
  const u = db.users[email];
  if (!u || u.verified) return res.status(400).json({ error: 'Аккаунт не найден' });
  const code = String(crypto.randomInt(100000, 999999));
  u.code = crypto.createHash('sha256').update(code).digest('hex');
  u.codeExp = Date.now() + 15 * 60 * 1000;
  try {
    await sendCode(email, code);
  } catch {
    return res.status(502).json({ error: 'Не удалось отправить письмо' });
  }
  saveDb();
  res.json({ ok: true });
});

app.post('/api/verify', (req, res) => {
  const email = normEmail(req.body?.email);
  const u = db.users[email];
  if (!u) return res.status(400).json({ error: 'Аккаунт не найден' });
  if (u.verified) return res.json({ token: issueToken(email), username: u.username });
  if (Date.now() > (u.codeExp || 0)) return res.status(400).json({ error: 'Код истёк, запроси новый' });
  const hash = crypto.createHash('sha256').update(String(req.body?.code || '')).digest('hex');
  if (!u.code || hash !== u.code) return res.status(400).json({ error: 'Неверный код' });
  u.verified = true;
  delete u.code;
  delete u.codeExp;
  saveDb();
  res.json({ token: issueToken(email), username: u.username });
});

app.post('/api/login', (req, res) => {
  const u = findUser(req.body?.email);
  if (!u || hashPass(String(req.body?.password || ''), u.salt) !== u.pass)
    return res.status(401).json({ error: 'Неверный email или пароль' });
  if (!u.verified) return res.json({ needVerify: true, email: u.email });
  res.json({ token: issueToken(u.email), username: u.username });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.email) }));

app.get('/api/state', auth, (req, res) => {
  const me = req.email;
  res.json({
    me: publicUser(me),
    channels: CHANNELS,
    friends: friendsOf(me),
    incoming: requestsOf(me, 'in'),
    outgoing: requestsOf(me, 'out'),
    unread: db.users[me].unread || {},
  });
});

app.get('/api/users', auth, (req, res) => {
  res.json({ users: Object.keys(db.users).map(publicUser) });
});

app.get('/api/search', auth, (req, res) => {
  const q = normName(req.query.q);
  if (!q) return res.json({ results: [] });
  const me = req.email;
  const results = Object.values(db.users)
    .filter(
      (u) =>
        u.email !== me &&
        (u.username.includes(q) || u.email.includes(q)) &&
        !db.friends[key(me, u.email)]
    )
    .slice(0, 8)
    .map((u) => ({ email: u.email, username: u.username, color: u.color, online: online.has(u.email) }));
  res.json({ results });
});

app.post('/api/friends/add', auth, (req, res) => {
  const target = findUser(req.body?.target);
  const me = req.email;
  if (!target) return res.status(400).json({ error: 'Пользователь не найден' });
  if (target.email === me) return res.status(400).json({ error: 'Себя нельзя добавить' });
  const k = key(me, target.email);
  if (db.friends[k]) return res.status(400).json({ error: 'Заявка уже отправлена' });
  db.friends[k] = { from: me, to: target.email, status: 'pending', since: Date.now() };
  saveDb();
  io.to('u:' + target.email).emit('friend:request', { user: publicUser(me) });
  res.json({ ok: true });
});

app.post('/api/friends/respond', auth, (req, res) => {
  const target = findUser(req.body?.target);
  const me = req.email;
  if (!target) return res.status(400).json({ error: 'Пользователь не найден' });
  const k = key(me, target.email);
  const f = db.friends[k];
  if (!f || f.status !== 'pending' || f.to !== me)
    return res.status(400).json({ error: 'Заявка не найдена' });
  if (req.body?.accept) {
    f.status = 'accepted';
    saveDb();
    io.to('u:' + target.email).emit('friend:accepted', { user: publicUser(me) });
    res.json({ ok: true });
  } else {
    delete db.friends[k];
    saveDb();
    io.to('u:' + target.email).emit('friend:declined', { user: publicUser(me) });
    res.json({ ok: true });
  }
});

app.delete('/api/friends/remove', auth, (req, res) => {
  const target = findUser(req.body?.target);
  if (target) {
    delete db.friends[key(req.email, target.email)];
    saveDb();
    io.to('u:' + target.email).emit('friend:removed', { user: publicUser(req.email) });
  }
  res.json({ ok: true });
});

app.get('/api/messages', auth, (req, res) => {
  const me = req.email;
  if (req.query.channel && CHANNELS.includes(req.query.channel))
    return res.json({ messages: channelHistory(req.query.channel) });
  const peer = findUser(req.query.with);
  if (peer) {
    const unread = db.users[me].unread || {};
    delete unread['dm:' + peer.email];
    saveDb();
    return res.json({ messages: dmHistory(me, peer.email) });
  }
  res.status(400).json({ error: 'bad query' });
});

// ---------- WebSocket ----------
const server = http.createServer(app);
const io = new Server(server);

const tokens = new Map(); // token -> email
const online = new Map(); // email -> Set(socketId)

io.use((socket, next) => {
  const email = tokens.get(socket.handshake.auth.token);
  if (!email) return next(new Error('unauthorized'));
  socket.email = email;
  next();
});

io.on('connection', (socket) => {
  const me = socket.email;
  const myName = db.users[me].username;
  socket.join('u:' + me);
  CHANNELS.forEach((c) => socket.join('ch:' + c));
  friendsOf(me).forEach((f) => socket.join('dm:' + key(me, f.email)));
  if (!online.has(me)) online.set(me, new Set());
  online.get(me).add(socket.id);
  io.emit('presence', { email: me, online: true });

  socket.on('dm:open', (peerId) => {
    const peer = findUser(peerId);
    if (peer) socket.join('dm:' + key(me, peer.email));
  });

  socket.on('typing', (target) => {
    if (target.startsWith('ch:')) {
      socket.to(target).emit('typing', { from: myName, fromEmail: me, target });
    } else if (target.startsWith('dm:')) {
      const peer = findUser(target.slice(3));
      if (peer) socket.to('u:' + peer.email).emit('typing', { from: myName, fromEmail: me, target });
    }
  });

  socket.on('message:send', (payload) => {
    const text = String(payload?.text || '').trim().slice(0, 2000);
    if (!text) return;
    const msg = { id: uid(), author: myName, authorEmail: me, text, ts: Date.now() };
    if (payload.channel && CHANNELS.includes(payload.channel)) {
      msg.channel = payload.channel;
      io.to('ch:' + msg.channel).emit('chat:message', msg);
    } else if (payload.to) {
      const peer = findUser(payload.to);
      if (!peer || !friendsOf(me).some((f) => f.email === peer.email)) return;
      msg.dm = key(me, peer.email);
      io.to('u:' + me).to('u:' + peer.email).emit('chat:message', msg);
      const other = db.users[peer.email];
      other.unread = other.unread || {};
      if (!online.has(peer.email)) {
        other.unread['dm:' + me] = (other.unread['dm:' + me] || 0) + 1;
        io.to('u:' + peer.email).emit('unread', { key: 'dm:' + me, count: other.unread['dm:' + me] });
      }
    } else {
      return;
    }
    db.messages.push(msg);
    if (db.messages.length > 5000) db.messages = db.messages.slice(-4000);
    saveDb();
  });

  socket.on('disconnect', () => {
    const set = online.get(me);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) {
        online.delete(me);
        io.emit('presence', { email: me, online: false });
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Q-Messenger запущен: http://localhost:${PORT} | SMTP кодов: ${SMTP ? 'вкл' : 'выкл (регистрация без подтверждения)'}`);
});
