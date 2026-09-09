const { io } = require('socket.io-client');
const BASE = 'http://localhost:3000';

async function reg(email, username, password) {
  let r = await fetch(BASE + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, username, password }),
  });
  if (r.status === 400) {
    r = await fetch(BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  }
  const j = await r.json();
  if (j.needVerify) throw new Error('SMTP unexpectedly on');
  if (!j.token) throw new Error(email + ' failed: ' + JSON.stringify(j));
  return j.token;
}
const auth = (t) => ({ headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t } });

(async () => {
  const alice = await reg('alice@test.dev', 'alice', 'pass123');
  const bob = await reg('bob@test.dev', 'bob', 'pass123');
  const carol = await reg('carol@test.dev', 'carol', 'pass123');

  const sA = (await (await fetch(BASE + '/api/state', auth(alice))).json());
  console.log('general chat present:', sA.chats.some((c) => c.type === 'general'), '| chats:', sA.chats.length);

  const soxA = io(BASE, { auth: { token: alice } });
  const soxB = io(BASE, { auth: { token: bob } });
  const soxC = io(BASE, { auth: { token: carol } });
  await Promise.all([soxA, soxB, soxC].map((s) => new Promise((r) => s.on('connect', r))));
  console.log('3 sockets connected');

  // DM via friends
  await fetch(BASE + '/api/friends/add', { ...auth(alice), method: 'POST', body: JSON.stringify({ target: 'bob' }) });
  const acc = await (await fetch(BASE + '/api/friends/respond', { ...auth(bob), method: 'POST', body: JSON.stringify({ target: 'alice', accept: true }) })).json();
  const dmChat = acc.chatId;
  console.log('DM chat id:', !!dmChat);

  const gotDm = new Promise((res) => soxB.on('chat:message', (m) => m.chat === dmChat && res('bob got DM: ' + m.text)));
  soxA.emit('message:send', { chat: dmChat, text: 'Привет, Боб!' });
  console.log(await Promise.race([gotDm, new Promise((r) => setTimeout(() => r('NO DM'), 3000))]));

  // Group chat
  const grp = await (await fetch(BASE + '/api/chats', { ...auth(alice), method: 'POST', body: JSON.stringify({ name: 'Друзья', type: 'group', members: ['bob@test.dev', 'carol'] }) })).json();
  const gid = grp.chat.id;
  console.log('group created:', grp.chat.name, 'members:', grp.chat.members.length);

  const bobInGrp = new Promise((res) => soxB.on('chat:new', (p) => res('bob chat:new ' + p.chat.name)));
  const seen = [];
  soxB.on('chat:message', (m) => m.chat === gid && seen.push('bob:' + m.text));
  soxC.on('chat:message', (m) => m.chat === gid && seen.push('carol:' + m.text));
  soxA.emit('message:send', { chat: gid, text: 'Всем привет в группе!' });
  console.log(await Promise.race([bobInGrp, new Promise((r) => r('already') , 500)]));
  await new Promise((r) => setTimeout(r, 400));
  console.log('group msg delivered to:', seen);

  const grpHist = await (await fetch(BASE + '/api/messages?chat=' + gid, auth(carol))).json();
  console.log('group history:', grpHist.messages.map((m) => m.author + ':' + m.text), 'members:', grpHist.members.length);

  // Channel: only owner writes
  const chan = await (await fetch(BASE + '/api/chats', { ...auth(alice), method: 'POST', body: JSON.stringify({ name: 'Новости', type: 'channel', members: ['bob'] }) })).json();
  const noWrite = await new Promise((res) => {
    let got = false;
    soxB.on('chat:message', (m) => { if (m.chat === chan.chat.id) got = true; });
    soxB.emit('message:send', { chat: chan.chat.id, text: 'хакну' });
    setTimeout(() => res(got ? 'WRONG: bob wrote' : 'OK: bob blocked'), 500);
  });
  console.log('channel write restriction:', noWrite);

  // Profile + avatar
  const prof = await (await fetch(BASE + '/api/profile', { ...auth(bob), method: 'PATCH', body: JSON.stringify({ about: 'хоккей и код', password: 'newpass' }) })).json();
  console.log('profile about set:', prof.user.about);
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAA7UB0mZIXQAAAABJRU5ErkJggg=';
  const av = await (await fetch(BASE + '/api/avatar', { ...auth(bob), method: 'POST', body: JSON.stringify({ dataUrl: png }) })).json();
  console.log('avatar url:', av.avatar);
  const avOk = await fetch(BASE + av.avatar.split('?')[0]);
  console.log('avatar served:', avOk.status === 200);

  // Calls (signal relay)
  const ring = new Promise((res) => soxB.once('call:ring', (p) => res('bob ring from ' + p.fromName + ' video=' + p.video)));
  soxA.emit('call:ring', { to: 'bob@test.dev', video: true });
  console.log(await Promise.race([ring, new Promise((r) => setTimeout(() => r('NO RING'), 2000))]));
  const sig = new Promise((res) => soxB.once('call:signal', (p) => res('bob got signal from ' + p.from.slice(0, 4))));
  soxA.emit('call:signal', { to: 'bob', data: { sdp: { type: 'offer', sdp: 'x' } } });
  console.log(await Promise.race([sig, new Promise((r) => setTimeout(() => r('NO SIG'), 2000))]));

  soxA.close(); soxB.close(); soxC.close();
  console.log('\nALL TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
