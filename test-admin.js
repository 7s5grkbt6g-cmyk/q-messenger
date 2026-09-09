const BASE = 'http://localhost:3000';
const H = (t) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
async function reg(email, username, password) {
  let r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, username, password }) });
  if (r.status === 400) r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const j = await r.json();
  if (!j.token) throw new Error(email + ': ' + JSON.stringify(j));
  return j.token;
}
(async () => {
  const admin = await reg('owner@qm.dev', 'LixerDEV', 'adminpass');
  const victim = await reg('v@test.dev', 'victim', 'pass1234');

  const me = await (await fetch(BASE + '/api/me', { headers: H(admin) })).json();
  console.log('admin flag:', me.user.admin === true);

  const ov = await (await fetch(BASE + '/api/admin/overview', { headers: H(admin) })).json();
  console.log('overview users:', ov.users.length, 'chats:', ov.chats.length);

  const denied = await fetch(BASE + '/api/admin/overview', { headers: H(victim) });
  console.log('non-admin denied:', denied.status === 403);

  const del = await (await fetch(BASE + '/api/admin/user/delete', { method: 'POST', headers: H(admin), body: JSON.stringify({ target: 'victim' }) })).json();
  console.log('user deleted:', del.ok);
  const ov2 = await (await fetch(BASE + '/api/admin/overview', { headers: H(admin) })).json();
  console.log('users after delete:', ov2.users.length);

  console.log('ADMIN TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
