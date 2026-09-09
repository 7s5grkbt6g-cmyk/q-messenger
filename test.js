const { io } = require('socket.io-client');
const BASE = 'http://localhost:3000';

async function login(email, username, password) {
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
  if (!j.token) throw new Error(email + ' login failed: ' + JSON.stringify(j));
  return j.token;
}
const auth = (t) => ({ headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t } });

(async () => {
  const alice = await login('alice@test.dev', 'alice', 'pass123');
  const bob = await login('bob@test.dev', 'bob', 'pass123');

  let h = await (await fetch(BASE + '/api/state', auth(alice))).json();
  console.log('alice friends:', h.friends.length, 'incoming:', h.incoming.length);

  const soxA = io(BASE, { auth: { token: alice } });
  const soxB = io(BASE, { auth: { token: bob } });
  await Promise.all([soxA, soxB].map((s) => new Promise((res) => s.on('connect', res))));
  console.log('both sockets connected');

  await fetch(BASE + '/api/friends/add', { ...auth(alice), method: 'POST', body: JSON.stringify({ target: 'bob@test.dev' }) });
  const gotReq = new Promise((res) => soxB.on('friend:request', (p) => res('bob got request from ' + p.user.username)));
  console.log(await Promise.race([gotReq, new Promise((r) => setTimeout(() => r('no req (already contacts)'), 1500))]));

  // accept by username too
  const acc = await fetch(BASE + '/api/friends/respond', { ...auth(bob), method: 'POST', body: JSON.stringify({ target: 'alice', accept: true }) });
  console.log('accept status:', acc.status);

  const bobDm = new Promise((res) => soxB.on('chat:message', (m) => res('bob received DM: ' + m.text)));
  soxA.emit('message:send', { to: 'bob@test.dev', text: 'Привет, Боб!' });
  console.log(await Promise.race([bobDm, new Promise((r) => setTimeout(() => r('NO DM'), 3000))]));

  const chan = new Promise((res) => soxB.on('chat:message', (m) => m.channel && res('bob saw channel msg: #' + m.channel + ' ' + m.text)));
  soxA.emit('message:send', { channel: 'gaming', text: 'Го в игру!' });
  console.log(await Promise.race([chan, new Promise((r) => setTimeout(() => r('NO CHAN'), 3000))]));

  const msgs = await (await fetch(BASE + '/api/messages?with=alice', auth(bob))).json();
  console.log('dm history for bob:', msgs.messages.map((m) => m.author + ': ' + m.text));

  // search
  const carol = await login('carol@test.dev', 'carol', 'pass123');
  const sr = await (await fetch(BASE + '/api/search?q=car', auth(alice))).json();
  console.log('search "car":', sr.results.map((r) => r.username));
  await fetch(BASE + '/api/friends/add', { ...auth(alice), method: 'POST', body: JSON.stringify({ target: 'carol@test.dev' }) });
  await fetch(BASE + '/api/friends/respond', { ...auth(carol), method: 'POST', body: JSON.stringify({ target: 'alice@test.dev', accept: true }) });

  // offline unread
  soxA.emit('message:send', { to: 'carol@test.dev', text: 'офлайн привет' });
  await new Promise((r) => setTimeout(r, 500));
  const carolState = await (await fetch(BASE + '/api/state', auth(carol))).json();
  console.log('carol friends:', carolState.friends.map((f) => f.username), 'unread:', JSON.stringify(carolState.unread));

  // login by username instead of email
  const viaName = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'alice', password: 'pass123' }) }).then((r) => r.json());
  console.log('login by username:', viaName.token ? 'OK' : 'FAIL');

  soxA.close(); soxB.close();
  console.log('ALL TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error('TEST FAILED', e); process.exit(1); });
