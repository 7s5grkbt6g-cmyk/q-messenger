/* Q-Messenger client — Telegram-style: чаты, группы/каналы, настройки, аватары, звонки */
const $ = (id) => document.getElementById(id);

const state = {
  token: localStorage.getItem('qm_token') || null,
  me: null,
  chats: [], // {id, type, name, members, last}
  friends: [],
  incoming: [], outgoing: [],
  users: {}, // email -> user
  unread: {}, // chatId -> n
  view: null, // chatId
  socket: null,
  call: null, // {peer, pc, local, video, dir}
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
const nameOf = (e) => byEmail(e).username || (e === state.me?.email ? state.me?.username : e.split('@')[0]);
const colorOf = (e) => byEmail(e).color || '#3390ec';
const isMe = (e) => e === state.me?.email;
const friendByEmail = (e) => state.friends.find((f) => f.email === e);
const chatById = (id) => state.chats.find((c) => c.id === id);
const dmPeer = (c) => (c.members.find((m) => !isMe(m)) || '');

function ravatar(target, size = '', opts = {}) {
  // target = email or {chat:true, name, color, online?} for groups
  let label, bg, img = null, online = false;
  if (opts.chat) {
    label = opts.hash ? '#' : initial(target.name);
    bg = target.color || '#3390ec';
  } else {
    const u = byEmail(target);
    label = initial(u.username || '?');
    bg = colorOf(target);
    img = u.avatar || null;
    online = !!u.online;
  }
  const style = img
    ? `background-image:url('${img}');background-size:cover;background-position:center`
    : `background:${bg}`;
  return `<div class="ravatar ${size}" style="${style}">${img ? '' : label}
    ${opts.dot && online ? '<span class="odot"></span>' : ''}</div>`;
}

function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = text;
  $('toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = 0; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, 4000);
}

let audioCtx;
function ping(times = 1) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    for (let i = 0; i < times; i++) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = i ? 740 : 950;
      const t0 = audioCtx.currentTime + i * 0.18;
      g.gain.setValueAtTime(0.05, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0); o.stop(t0 + 0.24);
    }
  } catch {}
}

/* ================= THEME ================= */
function applyTheme(night) {
  document.body.classList.toggle('night', night);
  $('themeIcon').innerHTML = night
    ? '<path d="M12.34 2.02A10 10 0 1 0 21.98 11.66 7.5 7.5 0 0 1 12.34 2.02Z"/>'
    : '<path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10ZM2 13h3a1 1 0 1 0 0-2H2a1 1 0 1 0 0 2Zm17 0h3a1 1 0 1 0 0-2h-3a1 1 0 1 0 0 2ZM11 2v3a1 1 0 1 0 2 0V2a1 1 0 1 0-2 0Zm0 17v3a1 1 0 1 0 2 0v-3a1 1 0 1 0-2 0ZM5.05 6.46 2.81 4.22a1 1 0 0 1 1.41-1.41l2.24 2.24a1 1 0 0 1-1.41 1.41Zm13.9 11.08 2.24 2.24a1 1 0 0 1-1.41 1.41l-2.24-2.24a1 1 0 0 1 1.41-1.41ZM4.22 19.8l2.24-2.24a1 1 0 1 1 1.41 1.41l-2.24 2.24a1 1 0 1 1-1.41-1.41ZM19.8 5.64l-2.24 2.24a1 1 0 0 1-1.41-1.41l2.24-2.24a1 1 0 1 1 1.41 1.41Z"/>';
}
applyTheme(localStorage.getItem('qm_night') === '1');
$('themeBtn').onclick = (e) => {
  e.stopPropagation();
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
    const body = { email: $('fEmail').value, password: $('fPassword').value, username: $('fUsername').value };
    const j = isRegister ? await api('/api/register', { method: 'POST', body }) : await api('/api/login', { method: 'POST', body });
    if (j.needVerify) return showVerify(j.email);
    state.token = j.token;
    localStorage.setItem('qm_token', j.token);
    await boot();
  } catch (err) { $('authError').textContent = err.message; }
};
$('verifyForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const j = await api('/api/verify', { method: 'POST', body: { email: $('fEmail').value.trim().toLowerCase(), code: $('fCode').value.trim() } });
    state.token = j.token;
    localStorage.setItem('qm_token', j.token);
    await boot();
  } catch (err) { $('verifyError').textContent = err.message; }
};
$('resendLink').onclick = async (e) => {
  e.preventDefault();
  try { await api('/api/resend', { method: 'POST', body: { email: $('fEmail').value.trim().toLowerCase() } }); toast('Новый код отправлен'); }
  catch (err) { toast(esc(err.message)); }
};
$('logoutBtn').onclick = () => { localStorage.removeItem('qm_token'); location.reload(); };

/* ================= BOOT ================= */
async function boot() {
  const s = await api('/api/state');
  state.me = s.me;
  state.chats = s.chats;
  state.friends = s.friends;
  state.incoming = s.incoming.map((i) => i.user.email);
  state.outgoing = s.outgoing.map((i) => i.user.email);
  state.unread = s.unread || {};
  const u = await api('/api/users');
  state.users = {};
  u.users.forEach((x) => (state.users[x.email] = x));

  $('auth').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('burgerBtn').textContent = state.me.username[0].toUpperCase();
  if (state.me.avatar) $('burgerBtn').style.cssText = `background-image:url('${state.me.avatar}');background-size:cover`;

  connectSocket();
  renderList();
  renderReqBadge();
  const first = sortedChats()[0];
  if (first) openChat(first.id); else showNoChat();
}

function connectSocket() {
  state.socket = io({ auth: { token: state.token } });
  const sock = state.socket;

  sock.on('connect_error', (e) => {
    if (e.message === 'unauthorized') { localStorage.removeItem('qm_token'); location.reload(); }
  });

  sock.on('presence', ({ email, online }) => {
    if (state.users[email]) state.users[email].online = online;
    renderList(); updateHeadStatus(); syncCallBtns();
    if (!$('contactModal').classList.contains('hidden')) renderContacts();
    if (!$('chatInfoModal').classList.contains('hidden')) renderChatInfo();
  });

  sock.on('chat:message', (msg) => {
    const c = upsertChatFromMsg(msg);
    if (state.view === msg.chat) {
      removeEmptyHint();
      appendMessage(msg);
      clearTyping(msg.chat);
    } else if (!isMe(msg.authorEmail)) {
      state.unread[msg.chat] = (state.unread[msg.chat] || 0) + 1;
      ping();
      toast(`💬 <b>${esc(c ? c.name : '')}</b> · ${esc(msg.author)}: ${esc(msg.text.slice(0, 36))}`);
    }
    renderList();
  });

  sock.on('typing', ({ chat, from }) => {
    if (chat === state.view) showTyping(from);
  });

  sock.on('unread', ({ chat, count }) => { state.unread[chat] = count; renderList(); });

  sock.on('chat:new', ({ chat }) => {
    mergeChat(chat);
    renderList();
    toast(`👥 Вы добавлены в «<b>${esc(chat.name)}</b>»`);
  });
  sock.on('chat:update', ({ chat }) => { if (chat) mergeChat(chat); renderList(); if (state.view === chat?.id) updateHead(); });
  sock.on('chat:deleted', ({ id }) => {
    state.chats = state.chats.filter((c) => c.id !== id);
    if (state.view === id) { state.view = null; showNoChat(); }
    renderList();
  });

  sock.on('profile:update', ({ email, user }) => {
    state.users[email] = { ...state.users[email], ...user };
    if (isMe(email)) state.me = { ...state.me, ...user };
    renderList(); rerenderMessagesAvatars();
  });

  sock.on('friend:request', ({ user }) => {
    state.users[user.email] = { ...user, online: true };
    if (!state.incoming.includes(user.email)) state.incoming.push(user.email);
    renderReqBadge();
    if (!$('contactModal').classList.contains('hidden')) renderContacts();
    toast(`✨ <b>${esc(user.username)}</b> хочет добавить вас в контакты`);
  });
  sock.on('friend:accepted', ({ user, chatId }) => {
    state.outgoing = state.outgoing.filter((e) => e !== user.email);
    if (!friendByEmail(user.email)) {
      state.friends.push(user);
      state.users[user.email] = { ...user, online: true };
      if (chatId) mergeChat({ id: chatId, type: 'dm', name: user.username, members: [state.me.email, user.email], last: null });
    }
    renderList(); renderReqBadge();
    if (!$('contactModal').classList.contains('hidden')) renderContacts();
    toast(`🎉 Теперь вы контакты с <b>${esc(user.username)}</b>`);
  });
  sock.on('friend:declined', ({ user }) => {
    state.outgoing = state.outgoing.filter((e) => e !== user.email);
    if (!$('contactModal').classList.contains('hidden')) renderContacts();
  });
  sock.on('friend:removed', ({ user }) => {
    state.friends = state.friends.filter((f) => f.email !== user.email);
    state.chats = state.chats.filter((c) => !(c.type === 'dm' && c.members.includes(user.email)));
    renderList();
    if (state.view && dmPeer(chatById(state.view) || { members: [] }) === user.email) { state.view = null; showNoChat(); }
    if (!$('contactModal').classList.contains('hidden')) renderContacts();
  });

  /* ---------- call signaling ---------- */
  sock.on('call:ring', ({ from, fromName, video }) => {
    if (state.call) { sock.emit('call:busy', { to: from }); return; }
    state.pendingCall = { peer: from, peerName: fromName, video };
    startRing();
    showCallUI({ peer: from, peerName: fromName, video, state: 'incoming' });
  });
  sock.on('call:accept', ({ from }) => {
    if (!state.call || state.call.peer !== from || state.call.state !== 'outgoing') return;
    setState('connecting');
    makeOffer();
  });
  sock.on('call:decline', ({ from }) => {
    if (state.call?.peer === from) { toast('📞 Вызов отклонён'); endCall(false); }
  });
  sock.on('call:busy', ({ from }) => {
    if (state.call?.peer === from) { toast('📞 Абонент занят'); endCall(false); }
  });
  sock.on('call:end', ({ from }) => {
    if (state.call?.peer === from) { toast('📞 Звонок завершён'); endCall(false); }
  });
  sock.on('call:signal', async ({ from, data }) => {
    if (!state.call || state.call.peer !== from) return;
    const pc = state.call.pc;
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        flushIce(pc);
        if (data.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sock.emit('call:signal', { to: from, data: { sdp: pc.localDescription } });
        }
      } else if (data.candidate) {
        if (pc.remoteDescription && pc.remoteDescription.type) await pc.addIceCandidate(data.candidate);
        else (pc._iceQueue = pc._iceQueue || []).push(data.candidate);
      }
    } catch (e) { console.warn('signal', e); }
  });
}

function flushIce(pc) {
  (pc._iceQueue || []).forEach((c) => pc.addIceCandidate(c).catch(() => {}));
  pc._iceQueue = [];
}

function upsertChatFromMsg(msg) {
  let c = chatById(msg.chat);
  if (c) c.last = { text: msg.text.slice(0, 90), author: msg.author, ts: msg.ts };
  return c;
}
function mergeChat(chat) {
  const i = state.chats.findIndex((c) => c.id === chat.id);
  if (i >= 0) state.chats[i] = { ...state.chats[i], ...chat };
  else state.chats.push(chat);
}

/* ================= CHAT LIST ================= */
function sortedChats() {
  const q = $('chatSearch').value.trim().toLowerCase();
  return state.chats
    .filter((c) => !q || chatName(c).toLowerCase().includes(q))
    .sort((a, b) => (b.last?.ts || (b.id === 'general' ? 1 : 0)) - (a.last?.ts || (a.id === 'general' ? 1 : 0)));
}
function chatName(c) {
  if (c.type === 'general') return 'Общий чат';
  if (c.type === 'dm') return nameOf(dmPeer(c));
  return c.name || 'Без названия';
}
function chatAvatarHtml(c, size) {
  if (c.type === 'general') return ravatar({ name: 'Q', color: '#3390ec' }, size, { chat: true });
  if (c.type === 'dm') return ravatar(dmPeer(c), size, { dot: true });
  return ravatar({ name: c.name, color: c.color || '#7bc862' }, size, { chat: true });
}

function renderList() {
  let html = '';
  let lastType = null;
  for (const c of sortedChats()) {
    const label = c.id === 'general' ? 'SERVER' : (c.type === 'dm' ? 'ЛИЧНЫЕ ЧАТЫ' : 'ГРУППЫ И КАНАЛЫ');
    if (label !== lastType) { lastType = label; html += `<div class="cl-label">${label}</div>`; }
    const un = state.unread[c.id];
    const lm = c.last;
    html += `<div class="cl-item ${state.view === c.id ? 'active' : ''}" data-k="${c.id}">
      <div class="cl-avatar">${chatAvatarHtml(c, 'sm')}</div>
      <div class="cl-main">
        <div class="cl-row"><div class="cl-name">${esc(chatName(c))}${c.type === 'channel' ? ' <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:-1px;opacity:.7"><path d="M12 2 4 6v6c0 5 3.4 9 8 10 4.6-1 8-5 8-10V6l-8-4Zm-1.5 13.5L7.5 12.5l1.4-1.4 1.6 1.6 4.1-4.1 1.4 1.4-5.5 5.5Z"/></svg>' : ''}</div><div class="cl-time">${lm ? fmtTime(lm.ts) : ''}</div></div>
        <div class="cl-row2">
          <div class="cl-preview">${lm ? (lm.author && !lm.author.startsWith('Вы') && chatTypeHasAuthors(c) && !isAuthorMe(lm) ? `<span class="from">${esc(lm.author)}:</span> ` : (isAuthorMe(lm) ? '<span class="from">Вы:</span> ' : '')) + esc(lm.text) : (c.type === 'general' ? 'Все сообщения сервера' : 'нет сообщений')}</div>
          ${un ? `<div class="cl-unread">${un}</div>` : ''}
        </div>
      </div>
    </div>`;
  }
  $('chatList').innerHTML = html || '<div class="fs-hint">Ничего не найдено</div>';
}
const isAuthorMe = (lm) => false; // author name only; keep simple
function chatTypeHasAuthors(c) { return c.type !== 'dm'; }

$('chatSearch').addEventListener('input', renderList);
$('chatList').addEventListener('click', (e) => {
  const item = e.target.closest('[data-k]');
  if (item) openChat(item.dataset.k);
});

/* ================= OPEN CHAT ================= */
function showNoChat() {
  $('headAvatar').innerHTML = '';
  $('headName').textContent = 'Q-Messenger';
  $('headStatus').textContent = 'выберите чат';
  $('messages').innerHTML = '<div class="empty-hint"><div class="big">💬</div>Выберите чат слева</div>';
  $('typingRow').innerHTML = '';
  syncCallBtns();
}

async function openChat(id) {
  const c = chatById(id);
  if (!c) return;
  state.view = id;
  document.querySelector('.app')?.classList.add('no-mobile-list');
  state.socket?.emit('view:open', id);

  updateHead();
  const j = await api('/api/messages?chat=' + encodeURIComponent(id));
  delete state.unread[id];
  c.members = j.members || c.members;
  if (j.messages.length) {
    const m = j.messages[j.messages.length - 1];
    c.last = { text: m.text.slice(0, 90), author: m.author, ts: m.ts };
  }
  renderList();

  renderedIds = new Set();
  $('messages').innerHTML = '';
  const canWrite = chatCanWrite(c);
  $('input').disabled = !canWrite;
  $('input').placeholder = canWrite ? 'Сообщение' : 'Только владелец канала может писать';
  if (!j.messages.length) {
    $('messages').innerHTML = `<div class="empty-hint" id="emptyHint"><div class="big">${c.type === 'dm' ? '👋' : c.type === 'general' ? '🌍' : '🎉'}</div>
      ${c.type === 'dm' ? `Начните переписку с <b>${esc(chatName(c))}</b>` : `Сообщений пока нет — напишите первым!`}</div>`;
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
  $('typingRow').innerHTML = '';
  syncCallBtns();
  $('input').focus();
}
const chatCanWrite = (c) => !c || c.type !== 'channel' || c.createdBy === state.me.email || c.id === 'general';

function removeEmptyHint() { $('emptyHint')?.closest('.empty-hint')?.remove(); }

function updateHead() {
  const c = chatById(state.view);
  if (!c) return showNoChat();
  $('headAvatar').innerHTML = chatAvatarHtml(c, '');
  $('headName').textContent = chatName(c);
  updateHeadStatus();
}
function updateHeadStatus() {
  const c = chatById(state.view);
  if (!c) return;
  const st = $('headStatus');
  if (c.type === 'general') st.textContent = `${c.members.length} участников`;
  else if (c.type === 'dm') {
    const p = byEmail(dmPeer(c));
    st.textContent = p.online ? 'в сети' : 'был(а) недавно';
    st.classList.toggle('off', !p.online);
  } else {
    const on = c.members.filter((m) => byEmail(m).online).length;
    st.textContent = `${c.members.length} ${c.type === 'channel' ? 'подписчиков' : 'участников'}, ${on} в сети`;
  }
  $('headAvatar').querySelector('.ravatar')?.classList.add('head-ra');
}

/* ================= MESSAGES ================= */
let renderedIds = new Set();
function appendMessage(msg) {
  if (renderedIds.has(msg.id)) return;
  renderedIds.add(msg.id);
  const c = chatById(msg.chat);
  const mine = isMe(msg.authorEmail);
  const multi = c && c.type !== 'dm';
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap' + (mine ? ' out' : '');
  const prev = wrapPrev();
  const grouped = prev && prev.dataset.author === msg.authorEmail && msg.ts - +prev.dataset.ts < 5 * 60 * 1000;
  const ticks = mine ? '<svg class="ticks" viewBox="0 0 16 11" fill="currentColor"><path d="M15.2 1.1 10.9 6.7l-.9.9-.8-.9-1.2-1.2.9-.9.3.4 3.5-4.3.9.9.6-.5ZM8.2 1.1 3.9 6.7 3 7.6l-.8-.9L1 5.5l.9-.9.3.4 3.5-4.3.9.9.6-.5Z"/></svg>' : '';
  wrap.dataset.author = msg.authorEmail;
  wrap.dataset.ts = msg.ts;
  const meta = `<span class="msg-meta">${fmtTime(msg.ts)}${ticks}</span>`;
  wrap.innerHTML = `
    ${multi && !mine ? `<div class="msg-ava">${ravatar(msg.authorEmail, 'xs')}</div>` : ''}
    <div class="bubble${grouped ? '' : ' msg-group'}">
      ${multi && !mine && !grouped ? `<div class="msg-author" style="color:${colorOf(msg.authorEmail)}">${esc(msg.author)}${byEmail(msg.authorEmail).admin ? ' <span class="crown">👑</span>' : ''}</div>` : ''}
      <span class="msg-text">${esc(msg.text)}</span>${meta}
    </div>`;
  if (!grouped) wrap.style.marginTop = multi ? '10px' : '8px';
  $('messages').appendChild(wrap);
  const box = $('messages');
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 300) box.scrollTop = box.scrollHeight;
}
function wrapPrev() {
  const kids = $('messages').children;
  for (let i = kids.length - 1; i >= 0; i--) if (kids[i].classList.contains('msg-wrap')) return kids[i];
  return null;
}
function rerenderMessagesAvatars() {
  if (!state.view) return;
  document.querySelectorAll('.msg-ava .ravatar').forEach((el) => {
    const wrap = el.closest('.msg-wrap');
    const e = wrap?.dataset.author;
    if (e && byEmail(e).avatar) { el.style.backgroundImage = `url('${byEmail(e).avatar}')`; el.textContent = ''; }
  });
}

/* ================= TYPING & COMPOSER ================= */
let typingTimer = null;
function showTyping(who) {
  $('typingRow').innerHTML = `<b>${esc(who)}</b> печатает<span class="tdots">…</span>`;
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => ($('typingRow').innerHTML = ''), 3500);
}
function clearTyping() { clearTimeout(typingTimer); $('typingRow').innerHTML = ''; }

let lastTyped = 0;
$('input').addEventListener('input', () => {
  if (!state.view) return;
  const now = Date.now();
  if (now - lastTyped > 1500) { lastTyped = now; state.socket.emit('typing', state.view); }
});
function sendMsg() {
  const text = $('input').value.trim();
  if (!text || !state.view) return;
  $('input').value = '';
  state.socket.emit('message:send', { chat: state.view, text });
}
$('sendBtn').onclick = sendMsg;
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
});

/* ================= HEADER: CHAT INFO & CALLS ================= */
$('chTitles').addEventListener('click', () => {
  const c = chatById(state.view);
  if (c && c.type !== 'dm') openChatInfo(c.id);
});

function syncCallBtns() {
  const c = chatById(state.view);
  const dm = c && c.type === 'dm' && friendByEmail(dmPeer(c));
  $('callAudioBtn').classList.toggle('hidden', !dm);
  $('callVideoBtn').classList.toggle('hidden', !dm);
}

$('callAudioBtn').onclick = () => startCall(dmPeer(chatById(state.view)), false);
$('callVideoBtn').onclick = () => startCall(dmPeer(chatById(state.view)), true);

/* ================= CHAT INFO MODAL ================= */
function openChatInfo(id) {
  $('chatInfoModal').classList.remove('hidden');
  renderChatInfo();
}
$('chatInfoBack').onclick = () => $('chatInfoModal').classList.add('hidden');
$('chatInfoModal').addEventListener('mousedown', (e) => { if (e.target === $('chatInfoModal')) $('chatInfoModal').classList.add('hidden'); });

function renderChatInfo() {
  const c = chatById(state.view);
  if (!c) return;
  const isOwner = c.createdBy === state.me.email;
  const members = (c.members || []).map((e) => {
    const u = byEmail(e);
    return `<div class="contact-row">${ravatar(e, 'sm', { dot: true })}
      <div style="min-width:0"><div class="contact-name">${esc(nameOf(e))}</div>
      <div class="contact-sub">${u.online ? 'в сети' : 'не в сети'}${isOwner && e === c.createdBy ? ' · владелец' : ''}</div></div></div>`;
  }).join('');
  $('chatInfoBody').innerHTML = `
    <div class="info-hero">
      ${chatAvatarHtml(c, 'lg')}
      <div class="info-name" id="infoName">${esc(chatName(c))}</div>
      <div class="info-sub">${c.members.length} ${c.type === 'channel' ? 'подписчиков' : 'участников'}</div>
    </div>
    ${isOwner && c.type !== 'general' ? `
      <div class="add-box" style="padding:8px 10px">
        <input class="add-input" id="renameInput" placeholder="Новое название" value="${esc(c.name)}" maxlength="40">
        <button class="tlink" data-iact="rename">Переименовать</button>
      </div>` : ''}
    ${isOwner && c.type === 'channel' ? '<div class="add-box" style="padding:0 10px 8px"><div class="contact-sub">В канале писать может только владелец.</div></div>' : ''}
    <div class="cl-label">Участники</div>
    ${members}
    ${c.type !== 'general' ? `<div style="padding:10px"><button class="tlink danger" data-iact="leave" style="width:100%;text-align:center;background:rgba(229,57,53,.08);padding:11px">Выйти из ${c.type === 'channel' ? 'канала' : 'группы'}</button></div>` : ''}
  `;
}
$('chatInfoBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-iact]');
  if (!btn) return;
  const c = chatById(state.view);
  try {
    if (btn.dataset.iact === 'rename') {
      const name = $('renameInput').value.trim();
      await api('/api/chats/' + c.id, { method: 'PATCH', body: { name } });
      $('chatInfoModal').classList.add('hidden');
    } else if (btn.dataset.iact === 'leave') {
      if (!confirm('Выйти из чата?')) return;
      await api('/api/chats/leave', { method: 'POST', body: { id: c.id } });
      state.chats = state.chats.filter((x) => x.id !== c.id);
      $('chatInfoModal').classList.add('hidden');
      state.view = null;
      renderList();
      showNoChat();
    }
  } catch (err) { toast(esc(err.message)); }
});

/* ================= NEW CHAT MENU / CREATE ================= */
$('newChatBtn').onclick = (e) => {
  e.stopPropagation();
  const ctx = $('ctx');
  ctx.innerHTML = `<div class="ctx-actions">
    <button class="tlink" data-cact="group">👥 Создать группу</button>
    <button class="tlink" data-cact="channel">📢 Создать канал</button>
    <button class="tlink" data-cact="contact">➕ Добавить контакт</button>
  </div>`;
  const r = $('newChatBtn').getBoundingClientRect();
  ctx.classList.remove('hidden');
  ctx.style.left = Math.min(r.left - 140, window.innerWidth - 280) + 'px';
  ctx.style.top = r.bottom + 6 + 'px';
};
$('ctx').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-cact]');
  if (!btn) return;
  $('ctx').classList.add('hidden');
  if (btn.dataset.cact === 'contact') { $('contactModal').classList.remove('hidden'); tab = 'add'; setTab(); renderContacts(); }
  else openCreate(btn.dataset.cact === 'channel' ? 'channel' : 'group');
});

function openCreate(type) {
  $('createModal').classList.remove('hidden');
  $('createTitle').textContent = type === 'channel' ? 'Новый канал' : 'Новая группа';
  document.querySelector('input[name=ctype][value=' + type + ']').checked = true;
  $('groupName').value = '';
  const picks = state.friends.map((f) => `
    <label class="pick-row"><input type="checkbox" value="${f.email}"> ${ravatar(f.email, 'xs')} <span>${esc(f.username)}</span></label>`).join('');
  $('memberPicks').innerHTML = picks;
  $('noContactsHint').classList.toggle('hidden', !!state.friends.length);
  setTimeout(() => $('groupName').focus(), 50);
}
$('createBack').onclick = () => $('createModal').classList.add('hidden');
$('createModal').addEventListener('mousedown', (e) => { if (e.target === $('createModal')) $('createModal').classList.add('hidden'); });
$('createGo').onclick = async () => {
  try {
    const name = $('groupName').value.trim();
    const type = document.querySelector('input[name=ctype]:checked').value;
    const members = [...document.querySelectorAll('#memberPicks input:checked')].map((i) => i.value);
    const j = await api('/api/chats', { method: 'POST', body: { name, type, members } });
    $('createModal').classList.add('hidden');
    if (j.chat) { mergeChat(j.chat); renderList(); openChat(j.chat.id); }
  } catch (err) { toast(esc(err.message)); }
};

/* ================= BURGER MENU (settings) ================= */
$('burgerBtn').onclick = (e) => {
  e.stopPropagation();
  const ctx = $('ctx');
  ctx.innerHTML = `<div class="contact-row" style="padding:4px 2px 10px">${ravatar(state.me.email, '', { dot: true })}
      <div><div class="contact-name">${esc(state.me.username)}${state.me.admin ? ' <span class="crown">👑</span>' : ''}</div>
      <div class="contact-sub">@${esc(state.me.username)}</div></div></div>
    <div class="ctx-actions">
      <button class="tlink" data-sact="settings">⚙️ Мои настройки</button>
      <button class="tlink" data-sact="contacts">👥 Контакты</button>
      ${state.me.admin ? '<button class="tlink" data-sact="admin">👑 Админ-панель</button>' : ''}
      <button class="tlink" data-sact="logout">🚪 Выйти</button>
    </div>
    <div class="menu-author">Q-Messenger · автор: <b>LixerDEV</b></div>`;
  const r = $('burgerBtn').getBoundingClientRect();
  ctx.classList.remove('hidden');
  ctx.style.left = r.left + 'px';
  ctx.style.top = r.bottom + 6 + 'px';
};
$('ctx').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-sact]');
  if (!btn) return;
  $('ctx').classList.add('hidden');
  if (btn.dataset.sact === 'settings') openSettings();
  if (btn.dataset.sact === 'contacts') { $('contactModal').classList.remove('hidden'); tab = 'list'; setTab(); renderContacts(); }
  if (btn.dataset.sact === 'admin') openAdmin();
  if (btn.dataset.sact === 'logout') $('logoutBtn').click();
});

/* ================= ADMIN ================= */
let atab = 'users';
let adminData = null;
async function openAdmin() {
  try {
    adminData = await api('/api/admin/overview');
    $('adminModal').classList.remove('hidden');
    renderAdmin();
  } catch (err) { toast(esc(err.message)); }
}
$('adminBack').onclick = () => $('adminModal').classList.add('hidden');
$('adminModal').addEventListener('mousedown', (e) => { if (e.target === $('adminModal')) $('adminModal').classList.add('hidden'); });
document.querySelectorAll('.stab[data-atab]').forEach((b) => (b.onclick = () => {
  atab = b.dataset.atab;
  document.querySelectorAll('.stab[data-atab]').forEach((x) => x.classList.toggle('active', x === b));
  renderAdmin();
}));

async function renderAdmin() {
  if (!adminData) return;
  const body = $('adminBody');
  const stats = `<div class="admin-stats">
    <div class="ast"><b>${adminData.users.length}</b><span>пользователей</span></div>
    <div class="ast"><b>${adminData.chats.length}</b><span>чатов</span></div>
    <div class="ast"><b>${adminData.totalMessages}</b><span>сообщений</span></div>
  </div>`;
  if (atab === 'users') {
    body.innerHTML = stats + adminData.users.map((u) => `
      <div class="contact-row">
        ${ravatar(u.email, 'sm')}
        <div style="min-width:0">
          <div class="contact-name">${esc(u.username)}${u.admin ? ' <span class="crown">👑</span>' : ''}${u.online ? ' <span class="on-dot"></span>' : ''}</div>
          <div class="contact-sub">${u.messages} сообщ. · ${new Date(u.createdAt).toLocaleDateString('ru-RU')}</div>
        </div>
        <div class="contact-act">${!u.admin && !isMe(u.email) ? `<button class="tlink danger" data-aact="udel" data-e="${u.email}">Удалить</button>` : ''}</div>
      </div>`).join('');
  } else {
    body.innerHTML = stats + adminData.chats.map((c) => `
      <div class="contact-row">
        <div style="min-width:0">
          <div class="contact-name">${esc(c.name)}${c.id === 'general' ? ' 🌍' : ''}</div>
          <div class="contact-sub">${c.type} · ${c.members} участник(ов)${c.createdBy ? ' · создатель ' + esc(c.createdBy) : ''}</div>
        </div>
        <div class="contact-act">${c.id !== 'general' ? `<button class="tlink danger" data-aact="cdel" data-i="${c.id}">Удалить</button>` : ''}</div>
      </div>`).join('');
  }
}
$('adminBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-aact]');
  if (!btn) return;
  try {
    if (btn.dataset.aact === 'udel') {
      if (!confirm('Удалить пользователя и все его данные?')) return;
      await api('/api/admin/user/delete', { method: 'POST', body: { target: btn.dataset.e } });
    } else if (btn.dataset.aact === 'cdel') {
      if (!confirm('Удалить чат и все его сообщения?')) return;
      await api('/api/admin/chat/delete', { method: 'POST', body: { id: btn.dataset.i } });
    }
    adminData = await api('/api/admin/overview');
    renderAdmin();
    const s = await api('/api/state');
    state.chats = s.chats;
    state.users = {};
    (await api('/api/users')).users.forEach((x) => (state.users[x.email] = x));
    renderList();
  } catch (err) { toast(esc(err.message)); }
});

function openSettings() {
  $('settingsModal').classList.remove('hidden');
  $('setAvatar').innerHTML = ravatar(state.me.email) + '<div class="cam-ov"><svg viewBox="0 0 24 24" width="24" height="24" fill="#fff"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4ZM9 2 7.17 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-3.17L15 2H9Z"/></svg><span>Изменить фото</span></div>'
    + '<input type="file" id="avatarFile" accept="image/*" hidden>';
  $('avatarFile').onchange = onAvatarPick;
  $('setName').value = state.me.username;
  $('setUsername').value = state.me.username;
  $('setAbout').value = state.me.about || '';
  $('setPassword').value = '';
  $('setEmailLine').textContent = 'Email для входа: ' + state.me.email;
}
$('settingsBack').onclick = () => $('settingsModal').classList.add('hidden');
$('settingsModal').addEventListener('mousedown', (e) => { if (e.target === $('settingsModal')) $('settingsModal').classList.add('hidden'); });

async function onAvatarPick(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const dataUrl = await resizeImage(file, 320);
    const j = await api('/api/avatar', { method: 'POST', body: { dataUrl } });
    state.me.avatar = j.avatar;
    state.users[state.me.email] = { ...state.users[state.me.email], avatar: j.avatar };
    $('burgerBtn').style.cssText = `background-image:url('${j.avatar}');background-size:cover`;
    openSettings();
    renderList();
    toast('Фото обновлено ✓');
  } catch (err) { toast(esc(err.message)); }
}
function resizeImage(file, size) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(size / img.width, size / img.height, 1);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.86));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

$('settingsSave').onclick = async () => {
  try {
    const body = {
      username: $('setUsername').value.trim(),
      about: $('setAbout').value.trim(),
    };
    const display = $('setName').value.trim();
    if (display && display !== state.me.username) body.username = normU(display);
    const pass = $('setPassword').value;
    if (pass) body.password = pass;
    const j = await api('/api/profile', { method: 'PATCH', body });
    state.me = { ...state.me, ...j.user };
    state.users[state.me.email] = { ...state.users[state.me.email], ...j.user };
    toast('Сохранено ✓');
    $('settingsModal').classList.add('hidden');
    renderList();
  } catch (err) { toast(esc(err.message)); }
};
const normU = (s) => s.toLowerCase().trim();

/* ================= CONTACTS MODAL ================= */
$('contactBtn').onclick = () => { $('contactModal').classList.remove('hidden'); tab = 'list'; setTab(); renderContacts(); };
$('contactBack').onclick = () => $('contactModal').classList.add('hidden');
$('contactModal').addEventListener('mousedown', (e) => { if (e.target === $('contactModal')) $('contactModal').classList.add('hidden'); });

let tab = 'list';
function setTab() { document.querySelectorAll('.stab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab)); }
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
      <div class="contact-name">${esc(u.username || email)}${u.admin ? ' <span class="crown">👑</span>' : ''}</div>
      <div class="contact-sub">${u.online ? 'в сети' : 'не в сети'}</div>
    </div>
    <div class="contact-act">${actions}</div>
  </div>`;
}

function renderContacts() {
  const body = $('contactBody');
  if (tab === 'list') {
    body.innerHTML = state.friends.length
      ? [...state.friends].sort((a, b) => (byEmail(b.email).online ? 1 : 0) - (byEmail(a.email).online ? 1 : 0))
          .map((f) => row(f.email, `<button class="tlink" data-act="chat" data-e="${f.email}">Сообщение</button>
             <button class="tlink danger" data-act="del" data-e="${f.email}">Удалить</button>`)).join('')
      : '<div class="fs-hint">Список контактов пуст.<br>Добавьте друга во вкладке «Добавить».</div>';
  } else if (tab === 'req') {
    const inc = state.incoming.map((e) => row(e,
      `<button class="tlink" data-act="accept" data-e="${e}">Принять</button>
       <button class="tlink danger" data-act="decline" data-e="${e}">Отклонить</button>`));
    const out = state.outgoing.map((e) => row(e, `<button class="tlink danger" data-act="cancel" data-e="${e}">Отменить</button>`));
    body.innerHTML = inc.length || out.length
      ? (inc.length ? '<div class="cl-label">Входящие заявки</div>' + inc.join('') : '') +
        (out.length ? '<div class="cl-label">Исходящие заявки</div>' + out.join('') : '')
      : '<div class="fs-hint">Заявок нет</div>';
  } else {
    body.innerHTML = `<div class="add-box">
      <p>Знайте email или имя пользователя Q-Messenger, чтобы добавить контакт.</p>
      <input class="add-input" id="addInput" placeholder="email или @username" autocomplete="off">
      <div id="addResults" style="margin-top:6px"></div></div>`;
    let t;
    $('addInput').oninput = async () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const q = $('addInput').value.trim().replace(/^@/, '');
        const box = $('addResults');
        if (!q) return (box.innerHTML = '');
        try {
          const j = await api('/api/search?q=' + encodeURIComponent(q));
          box.innerHTML = j.results.length
            ? j.results.map((u) => { state.users[u.email] = { ...u }; return row(u.email, `<button class="tlink" data-act="add" data-e="${u.email}">Добавить</button>`); }).join('')
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
      const dm = state.chats.find((c) => c.type === 'dm' && c.members.includes(email));
      if (dm) openChat(dm.id);
      else { toast('Откройте переписку из списка'); renderList(); }
    } else if (act === 'add') {
      await api('/api/friends/add', { method: 'POST', body: { target: email } });
      state.outgoing.push(email);
      btn.textContent = 'Заявка отправлена ✓';
      btn.style.color = 'var(--text-2)';
      renderReqBadge();
    } else if (act === 'accept' || act === 'decline') {
      const j = await api('/api/friends/respond', { method: 'POST', body: { target: email, accept: act === 'accept' } });
      state.incoming = state.incoming.filter((x) => x !== email);
      if (act === 'accept') {
        if (!friendByEmail(email)) state.friends.push({ email, ...byEmail(email) });
        if (j.chatId) mergeChat({ id: j.chatId, type: 'dm', name: nameOf(email), members: [state.me.email, email], last: null });
        renderList();
        openChat(j.chatId);
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
      state.chats = state.chats.filter((c) => !(c.type === 'dm' && c.members.includes(email)));
      renderList(); renderContacts();
    }
  } catch (err) { toast('⚠️ ' + esc(err.message)); }
});

document.addEventListener('click', () => $('ctx').classList.add('hidden'));

/* ================= CALLS (WebRTC) ================= */
const RTC_CFG = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };

async function startCall(peer, video) {
  if (state.call) return toast('Вы уже в звонке');
  state.socket.emit('call:ring', { to: peer, video });
  showCallUI({ peer, peerName: nameOf(peer), video, state: 'outgoing' });
}

function showCallUI({ peer, peerName, video, state: st }) {
  $('callOverlay').classList.remove('hidden');
  $('callOverlay').dataset.video = video ? '1' : '';
  $('callAvatar').innerHTML = ravatar(peer, 'lg');
  $('callName').textContent = peerName;
  $('callState').textContent = st === 'incoming' ? (video ? 'Входящий видеозвонок…' : 'Входящий звонок…') : 'Соединение…';
  $('acceptBtn').classList.toggle('hidden', st !== 'incoming');
  $('declineBtn').classList.toggle('hidden', st !== 'incoming');
  $('hangupBtn').classList.remove('hidden');
  $('micBtn').classList.toggle('hidden', st === 'incoming');
  $('camBtn').classList.toggle('hidden', !(video && st !== 'incoming'));
  document.body.classList.add('in-call');
}
function setState(s) {
  if (!state.call) return;
  state.call.state = s;
  $('callState').textContent =
    s === 'connecting' ? 'Соединение…' : s === 'active' ? 'Соединено' : s === 'outgoing' ? 'Ожидание ответа…' : 'Входящий звонок…';
}

async function getMedia(video) {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true, video: video ? { width: 640, height: 480 } : false });
  } catch {
    try { return await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { return null; }
  }
}

function newPeerConnection(peer) {
  const pc = new RTCPeerConnection(RTC_CFG);
  pc.onicecandidate = (e) => { if (e.candidate) state.socket.emit('call:signal', { to: peer, data: { candidate: e.candidate } }); };
  pc.ontrack = (e) => {
    const [stream] = e.streams;
    if (e.track.kind === 'video') {
      $('remoteVideo').srcObject = stream;
      $('remoteVideo').classList.add('show');
      $('callFace').classList.add('blur-face');
    } else {
      const a = document.createElement('audio');
      a.autoplay = true;
      a.srcObject = stream;
      document.body.appendChild(a);
      state.call._audio = state.call._audio || [];
      state.call._audio.push(a);
    }
  };
  pc.onconnectionstatechange = () => {
    const cs = pc.connectionState;
    if (cs === 'connected') setState('active');
    if (cs === 'failed' || cs === 'closed') endCall(false, 'Соединение потеряно');
  };
  return pc;
}

async function setupPc(video) {
  const c = state.call;
  c.local = await getMedia(video);
  if (c.local) {
    c.local.getTracks().forEach((t) => c.pc.addTrack(t, c.local));
    $('localVideo').srcObject = c.local;
    $('localVideo').classList.toggle('show', video);
  }
}

$('acceptBtn').onclick = async () => {
  const inc = state.pendingCall;
  if (!inc) return;
  stopRing();
  state.socket.emit('call:accept', { to: inc.peer });
  state.call = { peer: inc.peer, pc: newPeerConnection(inc.peer), video: inc.video, state: 'connecting' };
  showCallUI({ ...inc, state: 'connecting' });
  $('micBtn').classList.remove('hidden');
  $('camBtn').classList.toggle('hidden', !inc.video);
  await setupPc(inc.video);
};
$('declineBtn').onclick = () => {
  stopRing();
  state.socket.emit('call:decline', { to: state.pendingCall.peer });
  $('callOverlay').classList.add('hidden');
  document.body.classList.remove('in-call');
  state.pendingCall = null;
};
$('hangupBtn').onclick = () => endCall(true);

async function makeOffer() {
  if (!state.call) return;
  await setupPc(state.call.video);
  const offer = await state.call.pc.createOffer();
  await state.call.pc.setLocalDescription(offer);
  state.socket.emit('call:signal', { to: state.call.peer, data: { sdp: offer } });
  setState('connecting');
}

function endCall(emitEnd, msg) {
  const c = state.call;
  stopRing();
  state.pendingCall = null;
  if (!c) {
    $('callOverlay').classList.add('hidden');
    document.body.classList.remove('in-call');
    return;
  }
  if (emitEnd) state.socket.emit('call:end', { to: c.peer });
  try { c.pc?.close(); } catch {}
  c.local?.getTracks().forEach((t) => t.stop());
  (c._audio || []).forEach((a) => a.remove());
  $('remoteVideo').classList.remove('show');
  $('remoteVideo').srcObject = null;
  $('localVideo').classList.remove('show');
  $('localVideo').srcObject = null;
  $('callFace').classList.remove('blur-face');
  $('callOverlay').classList.add('hidden');
  document.body.classList.remove('in-call');
  state.call = null;
  if (msg) toast('📞 ' + msg);
}

$('micBtn').onclick = () => {
  const c = state.call;
  if (!c?.local) return;
  const t = c.local.getAudioTracks()[0];
  if (t) { t.enabled = !t.enabled; $('micBtn').classList.toggle('off', !t.enabled); }
};
$('camBtn').onclick = () => {
  const c = state.call;
  if (!c?.local) return;
  const t = c.local.getVideoTracks()[0];
  if (t) { t.enabled = !t.enabled; $('camBtn').classList.toggle('off', !t.enabled); }
};

// (pendingCall задаётся в обработчике call:ring)

/* ringtone */
let ringTimer = null;
function startRing() { stopRing(); ringTimer = setInterval(() => ping(2), 1600); }
function stopRing() { clearInterval(ringTimer); ringTimer = null; }

/* ================= MOBILE ================= */
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
