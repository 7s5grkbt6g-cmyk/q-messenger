/* Q-Messenger client */
const $ = (id) => document.getElementById(id);
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

const state = {
  token: localStorage.getItem('qm_token') || null,
  me: null,
  channels: [],
  friends: [],
  incoming: [],
  outgoing: [],
  users: {}, // username -> {username,color,online}
  unread: {}, // "dm:x" | "ch:x" -> count
  view: { type: 'ch', name: 'general' }, // or {type:'dm', name:'friend'}
  socket: null,
};

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initial = (n) => n[0].toUpperCase();
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const fmtDay = (ts) => {
  const d = new Date(ts), t = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, t)) return 'Сегодня';
  const y = new Date(t - 864e5);
  if (same(d, y)) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
};

function avatarHtml(user, cls = '', dot = false) {
  const online = state.users[user]?.online;
  return `<div class="avatar ${cls} ${online || !dot ? '' : 'off'}" style="background:${userColor(user)}">
    ${initial(user)}${dot ? `<span class="dot ${online ? '' : 'off'}"></span>` : ''}
  </div>`;
}
function userColor(name) {
  if (state.users[name]?.color) return state.users[name].color;
  if (name === state.me?.username) return state.me.color;
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 60% 50%)`;
}

function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = text;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

let audioCtx;
function ping() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 880;
    o.type = 'sine';
    g.gain.setValueAtTime(0.06, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);
    o.connect(g).connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.26);
  } catch {}
}

/* ---------- AUTH ---------- */
let isRegister = false;
$('authToggle').onclick = (e) => {
  e.preventDefault();
  isRegister = !isRegister;
  $('authBtn').textContent = isRegister ? 'Создать аккаунт' : 'Войти';
  $('authToggle').textContent = isRegister ? 'Уже есть? Войти' : 'Создать';
  $('authError').textContent = '';
};
$('authForm').onsubmit = async (e) => {
  e.preventDefault();
  $('authError').textContent = '';
  try {
    const body = { username: $('authUser').value, password: $('authPass').value };
    const j = await api('/api/' + (isRegister ? 'register' : 'login'), { method: 'POST', body });
    state.token = j.token;
    localStorage.setItem('qm_token', j.token);
    await boot();
  } catch (err) {
    $('authError').textContent = err.message;
  }
};
$('logoutBtn').onclick = () => {
  localStorage.removeItem('qm_token');
  location.reload();
};

/* ---------- BOOT ---------- */
async function boot() {
  const s = await api('/api/state');
  state.me = s.me;
  state.channels = s.channels;
  state.friends = s.friends;
  state.incoming = s.incoming.map((i) => i.user.username);
  state.outgoing = s.outgoing.map((i) => i.user.username);
  state.unread = s.unread || {};
  const u = await api('/api/users');
  state.users = {};
  u.users.forEach((x) => (state.users[x.username] = x));
  state.users[state.me.username] = s.me;

  $('auth').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('meName').textContent = state.me.username;
  $('meAvatar').innerHTML = initial(state.me.username);
  $('meAvatar').style.background = state.me.color;
  $('railMe').textContent = initial(state.me.username);
  $('railMe').style.background = state.me.color;
  $('railMe').title = state.me.username;

  connectSocket();
  renderSidebar();
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

  sock.on('presence', ({ username, online }) => {
    if (state.users[username]) state.users[username].online = online;
    renderSidebar();
    renderMembers();
  });

  sock.on('chat:message', (msg) => {
    const isDm = !!msg.dm;
    const viewing =
      (msg.channel && state.view.type === 'ch' && state.view.name === msg.channel) ||
      (isDm && state.view.type === 'dm' && (msg.author === state.me.username || msg.author === state.view.name));
    if (viewing) {
      appendMessage(msg, true);
    } else {
      const k = msg.channel ? 'ch:' + msg.channel : 'dm:' + msg.author;
      state.unread[k] = (state.unread[k] || 0) + 1;
      renderSidebar();
      renderRailBadges();
      if (!msg.channel) toast(`💬 ${msg.author}: ${esc(msg.text.slice(0, 60))}`);
    }
    if (msg.author !== state.me.username) { ping(); clearTyping(isDm ? 'dm:' + msg.author : 'ch:' + msg.channel); }
  });

  sock.on('typing', ({ from, target }) => {
    if (from === state.me.username) return;
    if (target === viewKey()) showTyping(from);
  });

  sock.on('friend:request', ({ user }) => {
    if (!state.incoming.includes(user.username)) state.incoming.push(user.username);
    state.users[user.username] = { ...user, online: true };
    renderReqBadge();
    if (!$('friendsOverlay').classList.contains('hidden')) renderFriends();
    toast(`✨ <b>${esc(user.username)}</b> хочет добавить тебя в друзья`);
  });
  sock.on('friend:accepted', ({ user }) => {
    state.outgoing = state.outgoing.filter((n) => n !== user.username);
    if (!state.friends.some((f) => f.username === user.username)) state.friends.push(user);
    sock.emit('dm:open', user.username);
    renderSidebar();
    renderReqBadge();
    if (!$('friendsOverlay').classList.contains('hidden')) renderFriends();
    toast(`🎉 Теперь вы друзья с <b>${esc(user.username)}</b>`);
  });
  sock.on('friend:declined', ({ user }) => {
    state.outgoing = state.outgoing.filter((n) => n !== user.username);
    renderReqBadge();
    if (!$('friendsOverlay').classList.contains('hidden')) renderFriends();
  });
  sock.on('friend:removed', ({ user }) => {
    state.friends = state.friends.filter((f) => f.username !== user.username);
    renderSidebar();
    renderMembers();
    if (state.view.type === 'dm' && state.view.name === user.username) openView({ type: 'ch', name: 'general' });
    if (!$('friendsOverlay').classList.contains('hidden')) renderFriends();
  });
  sock.on('unread', ({ key, count }) => {
    state.unread[key] = count;
    renderSidebar();
  });
}

const viewKey = () => (state.view.type === 'ch' ? 'ch:' + state.view.name : 'dm:' + state.view.name);

/* ---------- VIEWS ---------- */
async function openView(view) {
  state.view = view;
  if (view.type === 'dm') state.socket.emit('dm:open', view.name);
  $('chatTitle').textContent = view.type === 'ch' ? '# ' + view.name : '@ ' + view.name;
  $('chatTopic').textContent = view.type === 'ch' ? 'Общий канал сервера Q' : 'Личная переписка';
  document.querySelectorAll('[data-ch]').forEach((b) => b.classList.toggle('active', view.type === 'ch' && b.dataset.ch === view.name));
  renderRailBadges();
  const q = view.type === 'ch' ? 'channel=' + view.name : 'with=' + view.name;
  const j = await api('/api/messages?' + q);
  const k = view.type === 'ch' ? 'ch:' + view.name : 'dm:' + view.name;
  if (view.type === 'dm') { delete state.unread['dm:' + view.name]; renderSidebar(); }
  if (view.type === 'ch') { state.unread['ch:' + view.name] = 0; renderSidebar(); renderRailBadges(); }
  renderMessages(j.messages);
  $('input').focus();
}

$('sideBody').addEventListener('click', (e) => {
  const item = e.target.closest('[data-view]');
  if (!item) return;
  const [type, name] = item.dataset.view.split(':');
  openView({ type, name });
});
document.querySelectorAll('[data-ch]').forEach((b) =>
  (b.onclick = () => openView({ type: 'ch', name: b.dataset.ch }))
);

/* ---------- RENDER ---------- */
function renderSidebar() {
  let html = '<div class="side-label">Каналы</div>';
  for (const ch of state.channels) {
    const un = state.unread['ch:' + ch];
    html += `<div class="side-item ${state.view.type === 'ch' && state.view.name === ch ? 'active' : ''}" data-view="ch:${ch}">
      <span class="hash">#</span> ${ch} ${un ? `<span class="pill">${un}</span>` : ''}</div>`;
  }
  html += '<div class="side-label">Друзья</div>';
  if (!state.friends.length) html += '<div style="padding:6px 10px;font-size:13px;color:var(--text-faint)">Пока никого — добавь друга!</div>';
  for (const f of [...state.friends].sort((a, b) => (isOnline(b) - isOnline(a)) || a.username.localeCompare(b.username))) {
    const un = state.unread['dm:' + f.username];
    html += `<div class="side-item ${state.view.type === 'dm' && state.view.name === f.username ? 'active' : ''}" data-view="dm:${f.username}">
      ${avatarHtml(f.username, '', true)} ${esc(f.username)} ${un ? `<span class="pill">${un}</span>` : ''}</div>`;
  }
  $('sideBody').innerHTML = html;
  renderMembers();
}
const isOnline = (f) => (state.users[f.username]?.online ? 1 : 0);

function renderMembers() {
  const all = Object.values(state.users);
  const on = all.filter((u) => u.online).sort((a, b) => a.username.localeCompare(b.username));
  const off = all.filter((u) => !u.online).sort((a, b) => a.username.localeCompare(b.username));
  const row = (u) => `<div class="m-item ${u.online ? '' : 'off'}" data-view="dm:${u.username}" ${u.username === state.me.username ? 'style="cursor:default"' : ''}>
    ${avatarHtml(u.username, '', true)} ${esc(u.username)}${u.username === state.me.username ? ' <span style="font-size:10px;color:var(--text-faint)">(ты)</span>' : ''}</div>`;
  $('members').innerHTML =
    `<div class="m-label">В сети — ${on.length}</div>${on.map(row).join('')}
     ${off.length ? `<div class="m-label" style="margin-top:10px">Не в сети — ${off.length}</div>${off.map(row).join('')}` : ''}`;
}
$('members').addEventListener('click', (e) => {
  const item = e.target.closest('[data-view]');
  if (!item) return;
  const [type, name] = item.dataset.view.split(':');
  if (type === 'dm' && name !== state.me.username && state.friends.some((f) => f.username === name))
    openView({ type: 'dm', name });
});

function renderRailBadges() {
  document.querySelectorAll('.rail-ch').forEach((b) => {
    const un = state.unread['ch:' + b.dataset.ch];
    b.style.boxShadow = un ? '0 0 0 2px var(--red)' : '';
  });
}

let renderedIds = new Set();
function renderMessages(list) {
  renderedIds = new Set();
  $('messages').innerHTML = '';
  if (!list.length) {
    $('messages').innerHTML = `<div class="empty-hint"><div class="big">${state.view.type === 'ch' ? '🌌' : '👋'}</div>
      ${state.view.type === 'ch' ? `Начало канала <b>#${state.view.name}</b>. Напиши первым!` : `Напиши <b>${esc(state.view.name)}</b> первое сообщение`}</div>`;
  }
  let lastDay = null;
  for (const m of list) {
    const day = fmtDay(m.ts);
    if (day !== lastDay) {
      lastDay = day;
      const d = document.createElement('div');
      d.className = 'day-divider';
      d.textContent = day;
      $('messages').appendChild(d);
    }
    appendMessage(m, false);
  }
  scrollBottom(true);
}

function appendMessage(msg, animate) {
  const hint = $('messages .empty-hint');
  if (hint) hint.remove();
  if (renderedIds.has(msg.id)) return;
  renderedIds.add(msg.id);
  const el = document.createElement('div');
  el.className = 'msg' + (msg.author === state.me.username ? ' mine' : '');
  el.innerHTML = `${avatarHtml(msg.author)}
    <div class="msg-body">
      <div class="msg-meta"><span class="msg-name" style="color:${userColor(msg.author)}">${esc(msg.author)}</span><span class="msg-time">${fmtTime(msg.ts)}</span></div>
      <div class="msg-text">${esc(msg.text)}</div>
    </div>`;
  if (!animate) el.style.animation = 'none';
  $('messages').appendChild(el);
  scrollBottom();
}
function scrollBottom(force) {
  const box = $('messages');
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  if (force || near) box.scrollTop = box.scrollHeight;
}

$('messages').addEventListener('scroll', () => {});

/* ---------- TYPING ---------- */
let typingTimer = null;
let lastTyped = 0;
function showTyping(who) {
  let line = $('typingLine');
  if (!line) {
    line = document.createElement('div');
    line.id = 'typingLine';
    line.className = 'typing-line';
    document.querySelector('.composer').before(line);
  }
  line.innerHTML = `<b>${esc(who)}</b> печатает<span class="tdots">…</span>`;
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => line.remove(), 3500);
}
function clearTyping(k) {
  if (k === viewKey()) { clearTimeout(typingTimer); $('typingLine')?.remove(); }
}

/* ---------- COMPOSER ---------- */
$('input').addEventListener('input', () => {
  const now = Date.now();
  if (now - lastTyped > 1500) {
    lastTyped = now;
    state.socket.emit('typing', viewKey());
  }
});
async function sendMsg() {
  const text = $('input').value.trim();
  if (!text) return;
  $('input').value = '';
  const payload =
    state.view.type === 'ch'
      ? { channel: state.view.name, text }
      : { to: state.view.name, text };
  // socket echo of chat:message renders it (sender is in the room too)
  state.socket.emit('message:send', payload);
}
$('sendBtn').onclick = sendMsg;
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});

/* ---------- FRIENDS ---------- */
$('openFriends').onclick = () => {
  $('friendsOverlay').classList.remove('hidden');
  ftab = 'all';
  renderFriends();
};
$('closeFriends').onclick = () => $('friendsOverlay').classList.add('hidden');
$('friendsOverlay').addEventListener('mousedown', (e) => {
  if (e.target === $('friendsOverlay')) $('friendsOverlay').classList.add('hidden');
});

let ftab = 'all';
document.querySelectorAll('.ftab').forEach((b) => {
  b.onclick = () => {
    ftab = b.dataset.tab;
    document.querySelectorAll('.ftab').forEach((x) => x.classList.toggle('active', x === b));
    renderFriends();
  };
});

function renderReqBadge() {
  const n = state.incoming.length;
  const b = $('reqBadge');
  b.classList.toggle('hidden', !n);
  b.textContent = n;
  $('pendCount').textContent = n ? `(${n})` : '';
}

function renderFriends() {
  const body = $('friendsBody');
  const row = (name, sub, actions) => `<div class="friend-row">
    ${avatarHtml(name, '', true)}
    <div><div class="fname">${esc(name)}</div><div class="fsub">${sub}</div></div>
    <div class="fact">${actions}</div></div>`;
  const onlineStr = (name) => (state.users[name]?.online ? 'В сети' : 'Не в сети');

  if (ftab === 'all') {
    const list = [...state.friends].sort((a, b) => isOnline(b) - isOnline(a));
    body.innerHTML = list.length
      ? list.map((f) => row(f.username, onlineStr(f.username),
          `<button class="mini-btn purple" data-act="chat" data-n="${f.username}">Написать</button>
           <button class="mini-btn danger" data-act="del" data-n="${f.username}" title="Удалить">✕</button>`)).join('')
      : '<div class="fs-hint">У тебя пока нет друзей.<br>Перейди во вкладку «Добавить друга» ✦</div>';
  } else if (ftab === 'pending') {
    const inc = state.incoming.map((n) => row(n, 'Входящая заявка',
      `<button class="mini-btn ok" data-act="accept" data-n="${n}">Принять</button>
       <button class="mini-btn danger" data-act="decline" data-n="${n}">Отклонить</button>`));
    const out = state.outgoing.map((n) => row(n, 'Исходящая заявка',
      `<button class="mini-btn danger" data-act="cancel" data-n="${n}">Отменить</button>`));
    body.innerHTML = inc.length || out.length ? inc.join('') + out.join('') : '<div class="fs-hint">Нет ожидающих заявок</div>';
  } else {
    body.innerHTML = `<div class="add-friend-box">
      <h3>ДОБАВИТЬ ДРУГА</h3>
      <p>Введи имя пользователя, чтобы отправить заявку в друзья.</p>
      <input id="addSearch" placeholder="Начни вводить имя…" autocomplete="off">
      <div class="search-results" id="searchResults"></div></div>`;
    let t;
    $('addSearch').oninput = async () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const q = $('addSearch').value.trim();
        const box = $('searchResults');
        if (!q) return (box.innerHTML = '');
        try {
          const j = await api('/api/search?q=' + encodeURIComponent(q));
          box.innerHTML = j.results.length
            ? j.results.map((u) => row(u.username, onlineStr(u.username),
                `<button class="mini-btn purple" data-act="add" data-n="${u.username}">Отправить заявку</button>`)).join('')
            : '<div class="fs-hint" style="padding:16px">Никого не найдено</div>';
        } catch {}
      }, 250);
    };
  }
}

$('friendsBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const { act, n } = btn.dataset;
  try {
    if (act === 'chat') {
      $('friendsOverlay').classList.add('hidden');
      openView({ type: 'dm', name: n });
    } else if (act === 'add') {
      await api('/api/friends/add', { method: 'POST', body: { username: n } });
      state.outgoing.push(n);
      btn.outerHTML = '<span style="color:var(--text-dim);font-size:12.5px;align-self:center">Заявка отправлена ✓</span>';
      renderReqBadge();
    } else if (act === 'accept' || act === 'decline') {
      await api('/api/friends/respond', { method: 'POST', body: { username: n, accept: act === 'accept' } });
      state.incoming = state.incoming.filter((x) => x !== n);
      if (act === 'accept') {
        state.friends.push({ username: n, color: state.users[n]?.color });
        state.socket.emit('dm:open', n);
        renderSidebar();
      }
      renderFriends(); renderReqBadge();
    } else if (act === 'cancel') {
      await api('/api/friends/respond', { method: 'POST', body: { username: n, accept: false } });
      state.outgoing = state.outgoing.filter((x) => x !== n);
      renderFriends();
    } else if (act === 'del') {
      if (!confirm(`Удалить ${n} из друзей?`)) return;
      await api('/api/friends/remove', { method: 'DELETE', body: { username: n } });
      state.friends = state.friends.filter((f) => f.username !== n);
      renderSidebar(); renderFriends();
      if (state.view.type === 'dm' && state.view.name === n) openView({ type: 'ch', name: 'general' });
    }
  } catch (err) { toast('⚠️ ' + esc(err.message)); }
});

/* ---------- INIT ---------- */
(async () => {
  if (!state.token) return;
  try { await boot(); }
  catch { localStorage.removeItem('qm_token'); state.token = null; }
})();
