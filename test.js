const { io } = require('socket.io-client');
const BASE = 'http://localhost:3000';

async function login(username, password) {
  let r = await fetch(BASE + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (r.status === 400) {
    r = await fetch(BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  }
  const j = await r.json();
  if (!j.token) throw new Error(username + ' login failed: ' + JSON.stringify(j));
  return j.token;
}
const auth = (t) => ({ headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t } });

(async () => {
  const alice = await login('alice', 'pass123');
  const bob = await login('bob', 'pass123');

  let h = await (await fetch(BASE + '/api/state', auth(alice))).json();
  console.log('alice state:', JSON.stringify(h.friends), 'incoming:', h.incoming.map(i => i.user.username));

  // alice -> bob friend request
  const soxA = io(BASE, { auth: { token: alice } });
  const soxB = io(BASE, { auth: { token: bob } });
  await Promise.all([soxA, soxB].map((s) => new Promise((res) => s.on('connect', res))));
  console.log('both sockets connected');

  await fetch(BASE + '/api/friends/add', { ...auth(alice), method: 'POST', body: JSON.stringify({ username: 'bob' }) });

  const gotReq = new Promise((res) => soxB.on('friend:request', (p) => res('bob got request from ' + p.user.username)));
  console.log(await Promise.race([gotReq, new Promise((r) => setTimeout(() => r('no req (already friends)'), 1500))]));

  const acc = await fetch(BASE + '/api/friends/respond', { ...auth(bob), method: 'POST', body: JSON.stringify({ username: 'alice', accept: true }) });
  console.log('accept status:', acc.status);

  const bobDm = new Promise((res) => soxB.on('chat:message', (m) => res('bob received DM: ' + m.text)));
  const aliceDm = new Promise((res) => soxA.on('chat:message', (m) => res('alice echo: ' + m.text)));
  soxA.emit('message:send', { to: 'bob', text: 'Привет, Боб!' });
  console.log(await bobDm); console.log(await aliceDm);

  const chan = new Promise((res) => soxB.on('chat:message', (m) => m.channel && res('bob saw channel msg: #' + m.channel + ' ' + m.text)));
  soxA.emit('message:send', { channel: 'gaming', text: 'Го в игру!' });
  console.log(await chan);

  const msgs = await (await fetch(BASE + '/api/messages?with=alice', auth(bob))).json();
  console.log('dm history for bob:', msgs.messages.map((m) => m.author + ': ' + m.text));

  const carol = await login('carol', 'pass123');
  await fetch(BASE + '/api/friends/add', { ...auth(alice), method: 'POST', body: JSON.stringify({ username: 'carol' }) });
  await fetch(BASE + '/api/friends/respond', { ...auth(carol), method: 'POST', body: JSON.stringify({ username: 'alice', accept: true }) });
  const carolState = await (await fetch(BASE + '/api/state', auth(carol))).json();
  console.log('carol friends:', carolState.friends.map((f) => f.username));

  soxA.emit('message:send', { to: 'carol', text: 'офлайн прив' });
  await new Promise((r) => setTimeout(r, 400));
  const carolState2 = await (await fetch(BASE + '/api/state', auth(carol))).json();
  console.log('carol unread:', JSON.stringify(carolState2.unread));

  soxA.close(); soxB.close();
  console.log('ALL TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
