const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');
const AVATAR_DIR = path.join(DATA_DIR, 'avatars');

// SMTP для кодов подтверждения (Gmail: SMTP_USER=адрес, SMTP_PASS=пароль приложения)
const SMTP = process.env.SMTP_USER && process.env.SMTP_PASS
  ? require('nodemailer').createTransport({
      service: process.env.SMTP_SERVICE || 'gmail',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

fs.mkdirSync(AVATAR_DIR, { recursive: true });

function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { users: {}, friends: {}, chats: {}, messages: [] };
  }
}

let db = loadDb();
db.chats = db.chats || {};
db.messages = db.messages || [];

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
const key = (a, b) => [a, b].sort().join('|');
const normEmail = (e) => String(e || '').trim().toLowerCase();
const normName = (n) => String(n || '').trim().toLowerCase();

function userByEmail(email) { return db.users[email]; }
function userByName(name) { return Object.values(db.users).find((u) => u.username === normName(name)); }
function findUser(id) { return userByEmail(normEmail(id)) || userByName(id); }

/* ---------------- CHATS ---------------- */
const GENERAL_ID = 'general';
const ADMIN_USERNAME = normName(process.env.ADMIN_USERNAME || 'lixerdev');
function ensureGeneral() {
  if (!db.chats[GENERAL_ID]) {
    db.chats[GENERAL_ID] = {
      id: GENERAL_ID, name: 'Общий чат', type: 'general',
      members: Object.keys(db.users), createdBy: null, createdAt: Date.now(),
      color: '#3390ec',
    };
  } else if (db.chats[GENERAL_ID].type !== 'general') {
    db.chats[GENERAL_ID].type = 'general';
  }
  const g = db.chats[GENERAL_ID];
  g.members = Object.keys(db.users);
}
ensureGeneral();

function dmChatId(a, b) { return key(a, b); }
function ensureDmChat(a, b) {
  const id = dmChatId(a, b);
  if (!db.chats[id]) {
    db.chats[id] = { id, name: null, type: 'dm', members: [a, b], createdBy: a, createdAt: Date.now() };
  } else {
    const m = new Set(db.chats[id].members.concat([a, b]));
    db.chats[id].members = [...m];
  }
  return id;
}
function chatMembers(chatId) {
  const c = db.chats[chatId];
  if (!c) return [];
  return c.type === 'general' ? Object.keys(db.users) : c.members;
}
function isMember(chatId, email) {
  return chatMembers(chatId).includes(email);
}
function chatsOf(email) {
  const out = [];
  for (const c of Object.values(db.chats)) {
    if (c.type === 'general' || c.members.includes(email)) out.push(c);
  }
  return out;
}
function chatView(email) {
  const lastByChat = {};
  for (const m of db.messages) lastByChat[m.chat] = m;
  return chatsOf(email).map((c) => {
    const members = chatMembers(c.id);
    const last = lastByChat[c.id];
    let name = c.name;
    if (c.type === 'dm') {
      const other = members.find((e) => e !== email) || '';
      name = db.users[other]?.username || 'Диалог';
    }
    return {
      id: c.id,
      type: c.type,
      name,
      color: c.color || (c.type === 'general' ? '#3390ec' : null),
      createdBy: c.createdBy || null,
      members,
      last: last ? { text: last.text.slice(0, 90), author: last.author, ts: last.ts } : null,
    };
  });
}

/* ---------------- USERS ---------------- */
function publicUser(email) {
  const u = db.users[email];
  if (!u) return null;
  return {
    email,
    username: u.username,
    color: u.color,
    avatar: u.avatar || null,
    about: u.about || '',
    admin: !!u.admin,
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
    .filter(([k, f]) => f.status === 'pending' && k.split('|').includes(email) &&
      (dir === 'in' ? f.to === email : f.from === email))
    .map(([, f]) => ({ user: publicUser(dir === 'in' ? f.from : f.to) }));
}

/* ---------------- HTTP ---------------- */
const app = express();
app.use(express.json({ limit: '6mb' }));
app.use('/avatars', express.static(AVATAR_DIR));
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const t = req.headers['authorization']?.replace('Bearer ', '');
  const email = tokens.get(t);
  if (!email || !db.users[email]) return res.status(401).json({ error: 'unauthorized' });
  req.email = email;
  next();
}
function issueToken(email) {
  const token = uid() + uid();
  tokens.set(token, email);
  return token;
}
async function sendCode(email, code) {
  await SMTP.sendMail({
    from: `"Q-Messenger" <${process.env.SMTP_USER}>`,
    to: email,
    subject: 'Код подтверждения Q-Messenger',
    text: `Твой код подтверждения: ${code}\nДействителен 15 минут.`,
  });
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
    email, username, salt, pass: hashPass(password, salt),
    color: palette[crypto.randomInt(palette.length)],
    about: '', avatar: null, admin: username === ADMIN_USERNAME,
    createdAt: Date.now(), verified: !SMTP, unread: {},
  };
  db.users[email] = user;
  ensureGeneral();
  if (SMTP) {
    const code = String(crypto.randomInt(100000, 999999));
    user.code = crypto.createHash('sha256').update(code).digest('hex');
    user.codeExp = Date.now() + 15 * 60 * 1000;
    try { await sendCode(email, code); } catch (e) {
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
  const u = db.users[normEmail(req.body?.email)];
  if (!u || u.verified) return res.status(400).json({ error: 'Аккаунт не найден' });
  const code = String(crypto.randomInt(100000, 999999));
  u.code = crypto.createHash('sha256').update(code).digest('hex');
  u.codeExp = Date.now() + 15 * 60 * 1000;
  try { await sendCode(u.email, code); } catch { return res.status(502).json({ error: 'Не удалось отправить письмо' }); }
  saveDb();
  res.json({ ok: true });
});

app.post('/api/verify', (req, res) => {
  const u = db.users[normEmail(req.body?.email)];
  if (!u) return res.status(400).json({ error: 'Аккаунт не найден' });
  if (u.verified) return res.json({ token: issueToken(u.email), username: u.username });
  if (Date.now() > (u.codeExp || 0)) return res.status(400).json({ error: 'Код истёк, запроси новый' });
  const hash = crypto.createHash('sha256').update(String(req.body?.code || '')).digest('hex');
  if (!u.code || hash !== u.code) return res.status(400).json({ error: 'Неверный код' });
  u.verified = true; delete u.code; delete u.codeExp;
  saveDb();
  res.json({ token: issueToken(u.email), username: u.username });
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
    chats: chatView(me),
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
  const results = Object.values(db.users)
    .filter((u) => u.email !== req.email && (u.username.includes(q) || u.email.includes(q)) &&
      !db.friends[key(req.email, u.email)])
    .slice(0, 8)
    .map((u) => publicUser(u.email));
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
  if (!f || f.status !== 'pending' || f.to !== me) return res.status(400).json({ error: 'Заявка не найдена' });
  if (req.body?.accept) {
    f.status = 'accepted';
    const chatId = ensureDmChat(me, target.email);
    saveDb();
    io.to('u:' + target.email).emit('friend:accepted', { user: publicUser(me), chatId });
    res.json({ ok: true, chatId });
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

/* ---- groups / channels ---- */
app.post('/api/chats', auth, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 40);
  const type = req.body?.type === 'channel' ? 'channel' : 'group';
  const emails = Array.isArray(req.body?.members) ? req.body.members : [];
  if (name.length < 2) return res.status(400).json({ error: 'Название минимум 2 символа' });
  const me = req.email;
  const members = [...new Set([me, ...emails.map((e) => findUser(e)?.email)].filter(Boolean))];
  const palette = ['#3390ec', '#e17076', '#7bc862', '#a695e7', '#ee7aae', '#6ec9cb', '#faa774'];
  const id = uid();
  db.chats[id] = { id, name, type, members, createdBy: me, createdAt: Date.now(), color: palette[crypto.randomInt(palette.length)] };
  saveDb();
  members.forEach((m) => io.to('u:' + m).emit('chat:new', { chat: chatOne(m, id) }));
  res.json({ chat: chatOne(me, id) });
});

function chatOne(email, id) {
  return chatView(email).find((c) => c.id === id) || null;
}

app.post('/api/chats/add-members', auth, (req, res) => {
  const c = db.chats[req.body?.id];
  if (!c || c.type === 'general') return res.status(400).json({ error: 'Чат не найден' });
  if (!c.members.includes(req.email)) return res.status(403).json({ error: 'Вы не участник' });
  if (c.type === 'channel' && c.createdBy !== req.email) return res.status(403).json({ error: 'Только владелец канала' });
  const emails = (Array.isArray(req.body?.members) ? req.body.members : []).map((e) => findUser(e)?.email).filter(Boolean);
  const added = [];
  for (const e of emails) if (!c.members.includes(e)) { c.members.push(e); added.push(e); ensureDmChatSafe(c, e); }
  saveDb();
  [...new Set([...c.members, ...added])].forEach((m) => io.to('u:' + m).emit('chat:update', { chat: chatOne(m, c.id) }));
  res.json({ ok: true });
});
function ensureDmChatSafe() {}

app.post('/api/chats/leave', auth, (req, res) => {
  const c = db.chats[req.body?.id];
  if (!c || c.type === 'general') return res.status(400).json({ error: 'Чат не найден' });
  c.members = c.members.filter((m) => m !== req.email);
  if (c.members.length === 0) delete db.chats[c.id];
  saveDb();
  c.members.forEach((m) => io.to('u:' + m).emit('chat:update', { chat: chatOne(m, c.id) }));
  io.to('u:' + req.email).emit('chat:deleted', { id: c.id });
  res.json({ ok: true });
});

app.patch('/api/chats/:id', auth, (req, res) => {
  const c = db.chats[req.params.id];
  if (!c || c.type === 'general') return res.status(400).json({ error: 'Чат не найден' });
  if (c.createdBy !== req.email) return res.status(403).json({ error: 'Только создатель' });
  const name = String(req.body?.name || '').trim().slice(0, 40);
  if (name.length >= 2) c.name = name;
  if (req.body?.type === 'channel' || req.body?.type === 'group') c.type = req.body.type;
  saveDb();
  c.members.forEach((m) => io.to('u:' + m).emit('chat:update', { chat: chatOne(m, c.id) }));
  res.json({ ok: true });
});

/* ---- profile ---- */
app.patch('/api/profile', auth, (req, res) => {
  const u = db.users[req.email];
  if (req.body?.username) {
    const username = normName(req.body.username);
    if (!/^[a-z0-9_.-]{2,20}$/.test(username)) return res.status(400).json({ error: 'Имя: 2–20 символов' });
    if (Object.values(db.users).some((o) => o !== u && o.username === username))
      return res.status(400).json({ error: 'Имя занято' });
    u.username = username;
  }
  if (typeof req.body?.about === 'string') u.about = req.body.about.slice(0, 120);
  if (req.body?.password) {
    const np = String(req.body.password);
    if (np.length < 4) return res.status(400).json({ error: 'Пароль минимум 4 символа' });
    u.salt = crypto.randomBytes(8).toString('hex');
    u.pass = hashPass(np, u.salt);
  }
  saveDb();
  io.emit('profile:update', { email: u.email, user: publicUser(u.email) });
  res.json({ user: publicUser(u.email) });
});

/* ---- avatar (base64 data-url, уже уменьшенный клиентом) ---- */
app.post('/api/avatar', auth, (req, res) => {
  const dataUrl = String(req.body?.dataUrl || '');
  const m = dataUrl.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return res.status(400).json({ error: 'Некорректное изображение' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 4 * 1024 * 1024) return res.status(400).json({ error: 'Файл слишком большой' });
  const u = db.users[req.email];
  const v = Date.now();
  const file = req.email + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
  try {
    for (const f of fs.readdirSync(AVATAR_DIR)) if (f.startsWith(req.email + '.')) fs.unlinkSync(path.join(AVATAR_DIR, f));
    fs.writeFileSync(path.join(AVATAR_DIR, file), buf);
  } catch (e) { return res.status(500).json({ error: 'Не удалось сохранить' }); }
  u.avatar = '/avatars/' + file + '?v=' + v;
  saveDb();
  io.emit('profile:update', { email: u.email, user: publicUser(u.email) });
  res.json({ avatar: u.avatar });
});

/* ---- admin ---- */
app.get('/api/admin/overview', auth, (req, res) => {
  const u = db.users[req.email];
  if (!u?.admin) return res.status(403).json({ error: 'Только для администратора' });
  const msgCount = {};
  for (const m of db.messages) msgCount[m.authorEmail] = (msgCount[m.authorEmail] || 0) + 1;
  res.json({
    users: Object.keys(db.users).map((e) => ({
      ...publicUser(e), messages: msgCount[e] || 0,
    })),
    chats: Object.values(db.chats).map((c) => ({
      id: c.id, name: c.name || (c.type === 'dm' ? 'ЛС' : c.id), type: c.type,
      members: chatMembers(c.id).length, createdBy: db.users[c.createdBy]?.username || null,
    })),
    totalMessages: db.messages.length,
  });
});

app.post('/api/admin/user/delete', auth, (req, res) => {
  if (!db.users[req.email]?.admin) return res.status(403).json({ error: 'Только для администратора' });
  const target = findUser(req.body?.target);
  if (!target || target.email === req.email) return res.status(400).json({ error: 'Нельзя удалить этого пользователя' });
  const email = target.email;
  delete db.users[email];
  for (const k of Object.keys(db.friends)) if (k.split('|').includes(email)) delete db.friends[k];
  for (const c of Object.values(db.chats)) {
    if (c.members && c.members.includes(email)) {
      c.members = c.members.filter((m) => m !== email);
      if (c.createdBy === email) c.createdBy = c.members[0] || null;
    }
  }
  db.messages = db.messages.filter((m) => m.authorEmail !== email);
  try { for (const f of fs.readdirSync(AVATAR_DIR)) if (f.startsWith(email + '.')) fs.unlinkSync(path.join(AVATAR_DIR, f)); } catch {}
  for (const [t, e] of [...tokens]) if (e === email) tokens.delete(t);
  io.emit('presence', { email, online: false });
  saveDb();
  res.json({ ok: true });
});

app.post('/api/admin/chat/delete', auth, (req, res) => {
  if (!db.users[req.email]?.admin) return res.status(403).json({ error: 'Только для администратора' });
  const c = db.chats[req.body?.id];
  if (!c) return res.status(400).json({ error: 'Чат не найден' });
  if (c.id === GENERAL_ID) return res.status(400).json({ error: 'Общий чат удалить нельзя' });
  const emails = c.type === 'general' ? [] : c.members;
  delete db.chats[c.id];
  db.messages = db.messages.filter((m) => m.chat !== c.id);
  emails.forEach((m) => io.to('u:' + m).emit('chat:deleted', { id: c.id }));
  saveDb();
  res.json({ ok: true });
});

app.get('/api/messages', auth, (req, res) => {
  const me = req.email;
  const id = req.query.chat;
  if (!id || !db.chats[id] || !isMember(id, me)) return res.status(400).json({ error: 'bad query' });
  if (db.users[me].unread) { delete db.users[me].unread[id]; saveDb(); }
  const list = db.messages.filter((x) => x.chat === id).slice(-300);
  res.json({ messages: list, members: chatMembers(id) });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

/* ---------------- SOCKET ---------------- */
const server = http.createServer(app);
const io = new Server(server);
const tokens = new Map();
const online = new Map(); // email -> Set(socketId)

io.use((socket, next) => {
  const email = tokens.get(socket.handshake.auth.token);
  if (!email || !db.users[email]) return next(new Error('unauthorized'));
  socket.email = email;
  next();
});

function emitToMembers(chatId, exceptEmail, event, payload) {
  chatMembers(chatId).forEach((m) => { if (m !== exceptEmail) io.to('u:' + m).emit(event, payload); });
}

io.on('connection', (socket) => {
  const me = socket.email;
  const meName = () => db.users[me]?.username || me;
  socket.join('u:' + me);
  if (!online.has(me)) online.set(me, new Set());
  online.get(me).add(socket.id);
  io.emit('presence', { email: me, online: true });

  socket.on('typing', (chatId) => {
    if (db.chats[chatId] && isMember(chatId, me))
      emitToMembers(chatId, me, 'typing', { chat: chatId, from: meName(), fromEmail: me });
  });

  socket.on('message:send', ({ chat, text: raw } = {}) => {
    const text = String(raw || '').trim().slice(0, 2000);
    if (!text || !db.chats[chat] || !isMember(chat, me)) return;
    if (db.chats[chat].type === 'channel' && db.chats[chat].createdBy !== me) return;
    const msg = { id: uid(), chat, author: meName(), authorEmail: me, text, ts: Date.now() };
    db.messages.push(msg);
    if (db.messages.length > 6000) db.messages = db.messages.slice(-5000);
    const members = chatMembers(chat);
    for (const m of members) {
      if (m === me) continue;
      const viewing = [...online.get(m) || []].some((sid) => io.sockets.sockets.get(sid)?.rooms?.has('view:' + chat));
      if (!viewing && !online.has(m)) {
        db.users[m].unread = db.users[m].unread || {};
        db.users[m].unread[chat] = (db.users[m].unread[chat] || 0) + 1;
        io.to('u:' + m).emit('unread', { chat, count: db.users[m].unread[chat] });
      }
    }
    saveDb();
    io.to(['u:' + me, ...members.filter((x) => x !== me).map((x) => 'u:' + x)]).emit('chat:message', msg);
  });

  socket.on('view:open', (chatId) => { if (db.chats[chatId] && isMember(chatId, me)) socket.join('view:' + chatId); });
  socket.on('view:close', (chatId) => socket.leave('view:' + chatId));

  /* ---- звонки (WebRTC сигнализация 1-на-1) ---- */
  function relayCall(event, toId, extra) {
    const target = findUser(toId);
    if (!target) return;
    io.to('u:' + target.email).emit(event, { from: me, fromName: meName(), ...extra });
  }
  socket.on('call:ring', ({ to, video } = {}) => {
    if (findUser(to)) {
      io.to('u:' + findUser(to).email).emit('call:ring', { from: me, fromName: meName(), video: !!video });
    }
  });
  socket.on('call:accept', ({ to } = {}) => relayCall('call:accept', to));
  socket.on('call:decline', ({ to } = {}) => relayCall('call:decline', to));
  socket.on('call:end', ({ to } = {}) => relayCall('call:end', to));
  socket.on('call:busy', ({ to } = {}) => relayCall('call:busy', to));
  socket.on('call:signal', ({ to, data } = {}) => {
    const target = findUser(to);
    if (target) io.to('u:' + target.email).emit('call:signal', { from: me, data });
  });

  socket.on('disconnect', () => {
    const set = online.get(me);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) { online.delete(me); io.emit('presence', { email: me, online: false }); }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Q-Messenger запущен: http://localhost:${PORT} | SMTP: ${SMTP ? 'вкл' : 'выкл'}`);
});
