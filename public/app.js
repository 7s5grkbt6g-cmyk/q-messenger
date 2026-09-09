/* Q-Messenger client (Telegram-style, email auth) */
const $ = (id) => document.getElementById(id);

const state = {
  token: localStorage.getItem('qm_token') || null,
  me: null, // {email, username, color}
  channels: [],
  friends: [], // {email, username, color}
  incoming: [], // emails
  outgoing: [], // emails
  users: {}, // email -> {email, username, color, online}
  unread: {}, // 'ch:x' | 'dm:email' -> count
  lastMsg: {}, // 'ch:x' | 'dm:email' -> {text, author, ts}
  view: { type: 'ch', name: 'general' },
  socket: null,
};

const api = async (url, opts = {}) => {
  const r = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Ошибка сервера');
  return j;
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initial = (n) => (n || '?')[0].toUpperCase();
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const fmtDay = (ts) => {
  const d = new Date(ts), t = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, t)) return 'Сегодня';
  if (same(d, new Date(t - 864e5))) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
};
const byEmail = (e) => state.users[e] || {};
const nameOf = (e) => byEmail(e).username || (e === state.me?.email ? state.me.username : e);
const colorOf = (e) => byEmail(e).color || '#3390ec';
const isMe = (e) => e === state.me?.email;
const friendByEmail = (e) => state.friends.find((f) => f.email === e);

function ravatar(email, size = '', opts = {}) {
  const u = byEmail(email) || {};
  const label = opts.hash ? '#' : initial(u.username || '?');
  const bg = opts.hash ? 'linear-gradient(135deg,#37aee2,#1e96c8)' : colorOf(email);
  return `<div class="ravatar ${size}" style="background:${bg}">${label}
    ${opts.dot && u.online ? '<span class="odot"></span>' : ''}</div>`;
}

function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = text;
  $('toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = 0; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, 4000);
}

let audioCtx;
function ping() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = 950;
    g.gain.setValueAtTime(0.05, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.22);
    o.connect(g).connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.24);
  } catch {}
}

/* ================= THEME ================= */
function applyTheme(night) {
  document.body.classList.toggle('night', night);
  $('themeIcon').innerHTML = night
    ? '<path d="M12.34 2.02A10 10 0 1 0 21.98 11.66 7.5 7.5 0 0 1 12.34 2.02Z"/>'
    : '<path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10ZM2 13h3a1 1 0 1 0 0-2H2a1 1 0 0 0 0 2Zm17 0h3a1 1 0 1 0 0-2h-3a1 1 0 1 0 0 2ZM11 2v3a1 1 0 1 0 2 0V2a1 1 0 1 0-2 0Zm0 17v3a1 1 0 1 0 2 0v-3a1 1 0 1 0-2 0ZM5.05 6.46 2.81 4.22a1 1 0 0 1 1.41-1.41l2.24 2.24a1 1 0 0 1-1.41 1.41Zm13.9 11.08 2.24 2.24a1 1 0 0 1-1.41 1.41l-2.24-2.24a1 1 0 0 1 1.41-1.41ZM4.22 19.8l2.24-2.24a1 1 0 1 1 1.41 1.41l-2.24 2.24a1 1 0 1 1-1.41-1.41ZM19.8 5.64l-2.24 2.24a1 1 0 0 1-1.41-1.41l2.24-2.24a1 1 0 1 1 1.41 1.41Z"/>';
}
applyTheme(localStorage.getItem('qm_night') === '1');
$('themeBtn').onclick = () => {
  const night = !document.body.classList.contains('night');
  localStorage.setItem('qm_night', night ? '1' : '0');
  applyTheme(night);
};

/* ================= AUTH ================= */
let isRegister = false;
$('authToggle').onclick = (e) => {
  e.preventDefault();
  isRegister = !isRegister;
  $('regNameWrap').classList.toggle('hidden', !isRegister);
  $('authTitle').textContent = isRegister ? 'Создайте аккаунт' : 'Войдите в Q-Messenger';
  $('authHint').textContent = isRegister ? 'Почта — ваш логин' : 'Укажите email и пароль';
  $('authBtn').textContent = isRegister ? 'Зарегистрироваться' : 'Войти';
  $('switchText').textContent = isRegister ? 'Аккаунт уже есть?' : 'На аккаунте ещё нет?';
  $('authToggle').textContent = isRegister ? 'Войти' : 'Создать аккаунт';
  $('authError').textContent = '';
};

function showVerify(email) {
  $('authForm').classList.add('hidden');
  $('switchWrap').classList.add('hidden');
  $('verifyForm').classList.remove('hidden');
  $('verifyEmail').textContent = `Мы отправили код на ${email}`;
  $('fCode').focus();
}

$('authForm').onsubmit = async (e) => {
  e.preventDefault();
  $('authError').textContent = '';
  try {
    const body = {
      email: $('fEmail').value,
      password: $('fPassword').value,
      username: $('fUsername').value,
    };
    const j = isRegister ? await api('/api/register', { method: 'POST', body }) : await api('/api/login', { method: 'POST', body });
    if (j.needVerify) return showVerify(j.email);
    state.token = j.token;
    localStorage.setItem('qm_token', j.token);
    await boot();
  } catch (err) {
    $('authError').textContent = err.message;
  }
};
$('verifyForm').onsubmit = async (e) => {
  e.preventDefault();
  $('verifyError').textContent = '';
  try {
    const j = await api('/api/verify', { method: 'POST', body: { email: $('fEmail').value.trim().toLowerCase(), code: $('fCode').value.trim() } });
    state.token = j.token;
    localStorage.setItem('qm_token', j.token);
    await boot();
  } catch (err) {
    $('verifyError').textContent = err.message;
  }
};
$('resendLink').onclick = async (e) => {
  e.preventDefault();
  try {
    await api('/api/resend', { method: 'POST', body: { email: $('fEmail').value.trim().toLowerCase() } });
    toast('Новый код отправлен на почту');
  } catch (err) { toast(esc(err.message)); }
};
$('logoutBtn').onclick = () => {
  localStorage.removeItem('qm_token');
  location.reload();
};

/* ================= BOOT ================= */
async function boot() {
  const s = await api('/api/state');
  state.me = s.me;
  state.channels = s.channels;
  state.friends = s.friends;
  state.incoming = s.incoming.map((i) => i.user.email);
  state.outgoing = s.outgoing.map((i) => i.user.email);
  state.unread = s.unread || {};
  const u = await api('/api/users');
  state.users = {};
  u.users.forEach((x) => (state.users[x.email] = x));

  $('auth').classList.add('hidden');
  $('app').classList.remove('hidden');

  connectSocket();
  renderList();
  renderReqBadge();
  openView({ type: 'ch', name: 'general' });
}

function connectSocket() {
  state.socket = io({ auth: { token: state.token } });
  const sock = state.socket;

  sock.on('connect_error', (e) => {
    if (e.message === 'unauthorized') {
      localStorage.removeItem('qm_token');
      location.reload();
    }
  });

  sock.on('presence', ({ email, online }) => {
    if (state.users[email]) state.users[email].online = online;
    renderList();
    updateHeadStatus();
    if (!$('contactModal').classList.contains('hidden')) renderContacts();
  });

  sock.on('chat:message', (msg) => {
    const viewK = viewKey();
    const msgK = msg.channel ? 'ch:' + msg.channel : 'dm:' + (isMe(msg.authorEmail) ? msgDmPeer(msg) : msg.authorEmail);
    state.lastMsg[msgK] = { text: msg.text, author: msg.author, ts: msg.ts, mine: isMe(msg.authorEmail) };
    const viewing = msgK === viewK;
    if (viewing) {
      removeEmptyHint();
      appendMessage(msg);
    } else if (!isMe(msg.authorEmail)) {
      state.unread[msgK] = (state.unread[msgK] || 0) + 1;
      ping();
      if (msg.channel) toast(`💬 <b>#${msg.channel}</b> · ${esc(msg.author)}: ${esc(msg.text.slice(0, 40))}`);
      else toast(`💬 <b>${esc(msg.author)}</b>: ${esc(msg.text.slice(0, 40))}`);
    }
    renderList();
    if (isMe(msg.authorEmail) === false) clearTyping(msgK);
  });

  sock.on('typing', ({ from, fromEmail, target }) => {
    if (fromEmail === state.me.email) return;
    const expect = state.view.type === 'ch' ? 'ch:' + state.view.name : 'dm:' + state.me.email;
    if (target === expect) showTyping(from);
  });

  sock.on('friend:request', ({ user }) => {
    state.users[user.email] = { ...user, online: true };
    if (!state.incoming.includes(user.email)) state.incoming.push(user.email);
    renderReqBadge();
    if (!$('contactModal').classList.contains('hidden')) renderContacts();
    toast(`✨ <b>${esc(user.username)}</b> хочет добавить вас в контакты`);
  });
  sock.on('friend:accepted', ({ user }) => {
    state.outgoing = state.outgoing.filter((e) => e !== user.email);
    if (!friendByEmail(user.email)) {
      state.friends.push(user);
      state.users[user.email] = { ...user, online: true };
      sock.emit('dm:open', user.email);
    }
    renderList();
    renderReqBadge();
    if (!$('contactModal').classList.contains('hidden')) renderContacts();
    toast(`🎉 Теперь вы контакты с <b>${esc(user.username)}</b>`);
  });
  sock.on('friend:declined', ({ user }) => {
    state.outgoing = state.outgoing.filter((e) => e !== user.email);
    if (!$('contactModal').classList.contains('hidden')) renderContacts();
  });
  sock.on('friend:removed', ({ user }) => {
    state.friends = state.friends.filter((f) => f.email !== user.email);
    renderList();
    if (state.view.type === 'dm' && state.view.email === user.email) openView({ type: 'ch', name: 'general' });
    if (!$('contactModal').classList.contains('hidden')) renderContacts();
  });
  sock.on('unread', ({ key: k, count }) => {
    state.unread[k] = count;
    renderList();
  });
}

function msgDmPeer(msg) {
  return isMe(msg.authorEmail)
    ? msg.dm.split('|').find((e) => e !== state.me.email)
    : msg.authorEmail;
}
const viewKey = () => (state.view.type === 'ch' ? 'ch:' + state.view.name : 'dm:' + state.view.email);

/* ================= CHAT LIST ================= */
function renderList() {
  const q = $('chatSearch').value.trim().toLowerCase();
  const match = (s) => !q || s.toLowerCase().includes(q);
  const ts = (k) => state.lastMsg[k]?.ts || 0;
  let html = '';

  const chans = state.channels.filter((c) => match('#' + c) || match(c));
  if (chans.length) {
    html += '<div class="cl-label">Каналы сервера</div>';
    for (const c of chans.sort((a, b) => ts('ch:' + b) - ts('ch:' + a))) {
      const k = 'ch:' + c;
      html += chatItem(k, ravatar('', 'sm', { hash: true }), c, `#общий канал`, k,
        state.view.type === 'ch' && state.view.name === c);
    }
  }
  const frs = state.friends.filter((f) => match(f.username) || match(f.email))
    .sort((a, b) => ts('dm:' + b.email) - ts('dm:' + a.email));
  html += '<div class="cl-label">Контакты</div>';
  if (!frs.length) html += `<div class="fs-hint" style="padding:18px 12px;font-size:13px">${q ? 'Никого не найдено' : 'Контактов пока нет.<br>Нажмите 👤 вверху справа, чтобы добавить друга по email.'}</div>`;
  for (const f of frs) {
    const k = 'dm:' + f.email;
    html += chatItem(k, ravatar(f.email, 'sm', { dot: true }), f.username,
      byEmail(f.email).online ? 'в сети' : 'не в сети', k,
      state.view.type === 'dm' && state.view.email === f.email);
  }
  $('chatList').innerHTML = html;
}

function chatItem(k, avatar, name, preview, key, active) {
  const un = state.unread[key];
  const lm = state.lastMsg[key];
  const prev = lm
    ? (name !== preview && !key.startsWith('dm:') && lm.author && !lm.mine ? `<span class="from">${esc(lm.author)}:</span> ` : '') + esc(lm.text)
    : esc(preview);
  const time = lm ? fmtTime(lm.ts) : '';
  const statusRow = !lm && key.startsWith('dm:') ? '' : '';
  return `<div class="cl-item ${active ? 'active' : ''}" data-k="${key}">
    <div class="cl-avatar">${avatar}</div>
    <div class="cl-main">
      <div class="cl-row"><div class="cl-name">${esc(name)}</div><div class="cl-time">${time}</div></div>
      <div class="cl-row2"><div class="cl-preview">${prev}</div>${un ? `<div class="cl-unread">${un}</div>` : ''}</div>
    </div>
  </div>${statusRow}`;
}

$('chatSearch').addEventListener('input', renderList);
$('chatList').addEventListener('click', (e) => {
  const item = e.target.closest('[data-k]');
  if (!item) return;
  const [type, rest] = item.dataset.k.split(':');
  if (type === 'ch') openView({ type: 'ch', name: rest });
  else openView({ type: 'dm', email: rest });
});

/* ================= OPEN VIEW ================= */
async function openView(view) {
  state.view = view;
  if (view.type === 'dm') state.socket.emit('dm:open', view.email);
  document.querySelector('.app')?.classList.add('no-mobile-list');

  const k = viewKey();
  $('headAvatar').innerHTML = view.type === 'ch'
    ? ravatar('', '', { hash: true })
    : ravatar(view.email, '', { dot: true });
  $('headName').textContent = view.type === 'ch' ? view.name : nameOf(view.email);
  updateHeadStatus();

  const q = view.type === 'ch' ? 'channel=' + view.name : 'with=' + view.email;
  const j = await api('/api/messages?' + q);
  if (j.messages.length) {
    const m = j.messages[j.messages.length - 1];
    state.lastMsg[k] = { text: m.text, author: m.author, ts: m.ts, mine: isMe(m.authorEmail) };
  }
  if (state.unread[k]) { delete state.unread[k]; }
  renderList();
  renderedIds = new Set();
  $('messages').innerHTML = '';
  if (!j.messages.length) {
    $('messages').innerHTML = `<div class="empty-hint" id="emptyHint"><div class="big">${view.type === 'ch' ? '🌍' : '👋'}</div>
      ${view.type === 'ch' ? `Это канал <b>#${view.name}</b>. Напишите первым!` : `Начните переписку с <b>${esc(nameOf(view.email))}</b>`}</div>`;
  } else {
    let lastDay = null;
    for (const m of j.messages) {
      const day = fmtDay(m.ts);
      if (day !== lastDay) {
        lastDay = day;
        const d = document.createElement('div');
        d.className = 'day-divider';
        d.innerHTML = `<span class="msg-date">${day}</span>`;
        $('messages').appendChild(d);
      }
      appendMessage(m);
    }
  }
  $('messages').scrollTop = $('messages').scrollHeight;
  $('input').focus();
}
function removeEmptyHint() {
  const h = $('emptyHint');
  if (h) h.closest('.empty-hint').remove();
}

function updateHeadStatus() {
  if (state.view.type === 'ch') {
    const total = Object.values(state.users).length;
    const on = Object.values(state.users).filter((u) => u.online).length;
    $('headStatus').textContent = `${total} участников, ${on} в сети`;
    $('headStatus').classList.remove('off');
  } else {
    const u = byEmail(state.view.email);
    $('headStatus').textContent = u.online ? 'в сети' : `${u.email || ''}`;
    $('headStatus').classList.toggle('off', !u.online);
  }
}
$('ch-titles')?.addEventListener('click', () => {});

/* ================= MESSAGES ================= */
let renderedIds = new Set();
function appendMessage(msg) {
  if (renderedIds.has(msg.id)) return;
  renderedIds.add(msg.id);
  const mine = isMe(msg.authorEmail);
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap' + (mine ? ' out' : '');
  const isChannel = !!msg.channel;
  const showName = isChannel && !mine;
  const prev = wrapPrev();
  const grouped = prev && prev.dataset.author === msg.authorEmail && msg.ts - prev.dataset.ts < 5 * 60 * 1000;
  const meta = `<span class="msg-meta">${fmtTime(msg.ts)}${mine ? '<svg class="ticks" viewBox="0 0 16 11" fill="currentColor"><path d="M15.2 1.1 10.9 6.7l-.9.9-.8-.9-1.2-1.2.9-.9.3.4 3.5-4.3.9.9.6-.5ZM8.2 1.1 3.9 6.7 3 7.6l-.8-.9L1 5.5l.9-.9.3.4 3.5-4.3.9.9.6-.5Z"/></svg>' : ''}</span>`;
  wrap.dataset.author = msg.authorEmail;
  wrap.dataset.ts = msg.ts;
  wrap.innerHTML = `${
    isChannel && !mine ? `<div style="align-self:flex-end;margin:0 8px 2px 2px">${ravatar(msg.authorEmail, 'xs')}</div>` : ''
  }<div class="bubble${grouped ? '' : ' msg-group'}">
      ${showName && !grouped ? `<div class="msg-author" style="color:${authorColor(msg.authorEmail)}" data-p="${msg.authorEmail}">${esc(msg.author)}</div>` : ''}
      <span class="msg-text">${esc(msg.text)}</span>${meta}
    </div>`;
  if (!grouped && wrap.querySelector('.msg-group')) wrap.style.marginTop = '8px';
  $('messages').appendChild(wrap);
  const box = $('messages');
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 300) box.scrollTop = box.scrollHeight;
  void meta;
}
function wrapPrev() {
  const kids = $('messages').children;
  for (let i = kids.length - 1; i >= 0; i--) {
    if (kids[i].classList.contains('msg-wrap')) return kids[i];
  }
  return null;
}
function authorColor(email) {
  const c = colorOf(email);
  return c;
}

/* ================= TYPING ================= */
let typingTimer = null;
function showTyping(who) {
  $('typingRow').innerHTML = `<b>${esc(who)}</b> печатает<span class="tdots">…</span>`;
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => ($('typingRow').innerHTML = ''), 3500);
}
function clearTyping(k) {
  if (k === viewKey()) { clearTimeout(typingTimer); $('typingRow').innerHTML = ''; }
}

/* ================= COMPOSER ================= */
let lastTyped = 0;
$('input').addEventListener('input', () => {
  const now = Date.now();
  if (now - lastTyped > 1500) {
    lastTyped = now;
    state.socket.emit('typing', viewKey());
  }
});
function sendMsg() {
  const text = $('input').value.trim();
  if (!text) return;
  $('input').value = '';
  state.socket.emit('message:send',
    state.view.type === 'ch'
      ? { channel: state.view.name, text }
      : { to: state.view.email, text });
}
$('sendBtn').onclick = sendMsg;
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});

/* ================= CONTACTS MODAL ================= */
$('contactBtn').onclick = () => {
  $('contactModal').classList.remove('hidden');
  tab = 'list';
  setTab();
  renderContacts();
};
$('contactBack').onclick = () => $('contactModal').classList.add('hidden');
$('contactModal').addEventListener('mousedown', (e) => {
  if (e.target === $('contactModal')) $('contactModal').classList.add('hidden');
});

let tab = 'list';
function setTab() {
  document.querySelectorAll('.stab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
}
document.querySelectorAll('.stab').forEach((b) => (b.onclick = () => { tab = b.dataset.tab; setTab(); renderContacts(); }));

function renderReqBadge() {
  const n = state.incoming.length;
  $('reqBadge').classList.toggle('hidden', !n);
  $('reqBadge').textContent = n;
  $('pendCount').textContent = n ? `(${n})` : '';
}

function row(email, actions) {
  const u = byEmail(email);
  return `<div class="contact-row">
    ${ravatar(email, '', { dot: true })}
    <div style="min-width:0">
      <div class="contact-name">${esc(u.username || email)}</div>
      <div class="contact-sub">${u.online ? 'в сети' : esc(u.email || '')}</div>
    </div>
    <div class="contact-act">${actions}</div>
  </div>`;
}

function renderContacts() {
  const body = $('contactBody');
  if (tab === 'list') {
    body.innerHTML = state.friends.length
      ? [...state.friends].sort((a, b) => (byEmail(b.email).online) - (byEmail(a.email).online))
          .map((f) => row(f.email,
            `<button class="tlink" data-act="chat" data-e="${f.email}">Сообщение</button>
             <button class="tlink danger" data-act="del" data-e="${f.email}" title="Удалить контакт">Удалить</button>`)).join('')
      : '<div class="fs-hint">Список контактов пуст.<br>Добавьте друга во вкладке «Добавить».</div>';
  } else if (tab === 'req') {
    const inc = state.incoming.map((e) => row(e,
      `<button class="tlink" data-act="accept" data-e="${e}">Принять</button>
       <button class="tlink danger" data-act="decline" data-e="${e}">Отклонить</button>`));
    const out = state.outgoing.map((e) => row(e,
      `<button class="tlink danger" data-act="cancel" data-e="${e}">Отменить</button>`));
    body.innerHTML = inc.length || out.length
      ? (inc.length ? '<div class="cl-label">Входящие заявки</div>' + inc.join('') : '') +
        (out.length ? '<div class="cl-label">Исходящие заявки</div>' + out.join('') : '')
      : '<div class="fs-hint">Заявок нет</div>';
  } else {
    body.innerHTML = `<div class="add-box">
      <p>Знайте адрес электронной почты или имя пользователя Q-Messenger, чтобы добавить контакт.</p>
      <input class="add-input" id="addInput" placeholder="email или @username" autocomplete="off">
      <div id="addResults" style="margin-top:6px"></div></div>`;
    let t;
    $('addInput').oninput = async () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const q = $('addInput').value.trim();
        const box = $('addResults');
        if (!q) return (box.innerHTML = '');
        try {
          const j = await api('/api/search?q=' + encodeURIComponent(q));
          box.innerHTML = j.results.length
            ? j.results.map((u) => {
                state.users[u.email] = { ...u };
                return row(u.email, `<button class="tlink" data-act="add" data-e="${u.email}">Добавить контакт</button>`);
              }).join('')
            : '<div class="fs-hint">Никого не найдено</div>';
        } catch {}
      }, 250);
    };
    setTimeout(() => $('addInput')?.focus(), 50);
  }
}

$('contactBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const { act, e: email } = btn.dataset;
  try {
    if (act === 'chat') {
      $('contactModal').classList.add('hidden');
      openView({ type: 'dm', email });
    } else if (act === 'add') {
      await api('/api/friends/add', { method: 'POST', body: { target: email } });
      state.outgoing.push(email);
      btn.textContent = 'Заявка отправлена ✓';
      btn.classList.remove('tlink');
      btn.style.color = 'var(--text-2)';
      renderReqBadge();
    } else if (act === 'accept' || act === 'decline') {
      await api('/api/friends/respond', { method: 'POST', body: { target: email, accept: act === 'accept' } });
      state.incoming = state.incoming.filter((x) => x !== email);
      if (act === 'accept') {
        if (!friendByEmail(email)) state.friends.push({ email, ...byEmail(email) });
        state.socket.emit('dm:open', email);
        renderList();
      }
      renderContacts(); renderReqBadge();
    } else if (act === 'cancel') {
      await api('/api/friends/respond', { method: 'POST', body: { target: email, accept: false } });
      state.outgoing = state.outgoing.filter((x) => x !== email);
      renderContacts();
    } else if (act === 'del') {
      if (!confirm('Удалить контакт?')) return;
      await api('/api/friends/remove', { method: 'DELETE', body: { target: email } });
      state.friends = state.friends.filter((f) => f.email !== email);
      renderList(); renderContacts();
      if (state.view.type === 'dm' && state.view.email === email) openView({ type: 'ch', name: 'general' });
    }
  } catch (err) { toast('⚠️ ' + esc(err.message)); }
});

/* profile popover on message author click */
$('messages').addEventListener('click', (e) => {
  const a = e.target.closest('[data-p]');
  const ctx = $('ctx');
  if (!a) { ctx.classList.add('hidden'); return; }
  const email = a.dataset.p;
  const u = byEmail(email);
  const fr = friendByEmail(email);
  ctx.innerHTML = `<div class="contact-row">${ravatar(email, '', { dot: true })}
    <div><div class="contact-name">${esc(u.username || '')}</div>
    <div class="contact-sub">${u.online ? 'в сети' : 'не в сети'}</div></div></div>
    <div class="ctx-actions">${
      fr ? `<button class="tlink" data-pact="chat" data-e="${email}">Отправить сообщение</button>`
         : email !== state.me.email ? `<button class="tlink" data-pact="add" data-e="${email}">Добавить в контакты</button>` : ''
    }</div>`;
  const r = a.getBoundingClientRect();
  ctx.classList.remove('hidden');
  ctx.style.left = Math.min(r.left, window.innerWidth - 260) + 'px';
  ctx.style.top = r.bottom + 6 + 'px';
  e.stopPropagation();
});
document.addEventListener('click', () => $('ctx').classList.add('hidden'));
$('ctx').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-pact]');
  if (!btn) return;
  const { pact, e: email } = btn.dataset;
  $('ctx').classList.add('hidden');
  try {
    if (pact === 'chat') openView({ type: 'dm', email });
    else {
      await api('/api/friends/add', { method: 'POST', body: { target: email } });
      state.outgoing.push(email);
      renderReqBadge();
      toast('Заявка отправлена ✓');
    }
  } catch (err) { toast(esc(err.message)); }
});

/* mobile back */
const backBtn = document.createElement('button');
backBtn.className = 'tg-icon';
backBtn.id = 'backBtn';
backBtn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2Z"/></svg>';
backBtn.style.display = 'none';
backBtn.onclick = () => document.querySelector('.app').classList.remove('no-mobile-list');
document.querySelector('.chat-head').prepend(backBtn);
const mq = window.matchMedia('(max-width: 760px)');
const syncBack = () => (backBtn.style.display = mq.matches ? 'grid' : 'none');
mq.addEventListener('change', syncBack); syncBack();

/* ================= INIT ================= */
(async () => {
  if (!state.token) return;
  try { await boot(); }
  catch { localStorage.removeItem('qm_token'); state.token = null; }
})();
