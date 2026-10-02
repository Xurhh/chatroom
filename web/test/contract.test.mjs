/*!
 * test/contract.test.mjs —— REST 契约测试（不连真后端，用 fetch 替身逐条核对）
 *
 * guide 8.2 的硬要求是"非 mock 模式下所有请求路径、字段名与契约一字不差"，
 * 所以这里断言的是 method + 完整 URL（含 query 顺序与编码）+ 请求头 + body。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, createFetchStub, plain } from './harness.mjs';

const REAL_LOCATION = { search: '?mock=0', protocol: 'http:', href: 'http://localhost:5173/?mock=0' };

function setup(routes = []) {
  const fetchStub = createFetchStub(routes);
  const env = createEnv({ location: REAL_LOCATION, fetch: fetchStub });
  const CR = env.load('js/config.js', 'js/store.js', 'js/api.js'); // MOCK=false，不需要 mock.js
  CR.api.setToken('tok-123');
  return { CR, fetchStub };
}

test('POST /auth/register：不带 Authorization，body 只有 username/password', async () => {
  const { CR, fetchStub } = setup([{ match: '/auth/register', method: 'POST', response: { status: 201, body: { user_id: 'u1', created_at: 1 } } }]);
  const res = await CR.api.register('alice', 'secret1');
  assert.deepEqual(plain(res), { user_id: 'u1', created_at: 1 });

  const call = fetchStub.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'http://localhost:8080/api/v1/auth/register');
  assert.deepEqual(call.body, { username: 'alice', password: 'secret1' });
  assert.equal(call.headers['Authorization'], undefined, '注册不需要带 token');
  assert.equal(call.headers['Content-Type'], 'application/json');
});

test('POST /auth/login：路径与响应字段（token/expires_at/user）', async () => {
  const { CR, fetchStub } = setup([
    { match: '/auth/login', method: 'POST', response: { status: 200, body: { token: 't', expires_at: 9, user: { id: 'u1', name: 'alice' } } } },
  ]);
  const res = await CR.api.login('alice', 'secret1');
  assert.equal(res.token, 't');
  assert.equal(res.user.id, 'u1');
  assert.equal(fetchStub.calls[0].url, 'http://localhost:8080/api/v1/auth/login');
  assert.equal(fetchStub.calls[0].headers['Authorization'], undefined);
});

test('GET /users/me：带 Bearer token', async () => {
  const { CR, fetchStub } = setup([{ match: '/users/me', response: { status: 200, body: { id: 'u1', name: 'alice' } } }]);
  const me = await CR.api.me();
  assert.equal(me.name, 'alice');
  assert.equal(fetchStub.calls[0].method, 'GET');
  assert.equal(fetchStub.calls[0].url, 'http://localhost:8080/api/v1/users/me');
  assert.equal(fetchStub.calls[0].headers['Authorization'], 'Bearer tok-123');
});

test('GET /rooms：query 只在有值时出现', async () => {
  const { CR, fetchStub } = setup([
    { match: '/rooms?', response: { status: 200, body: { rooms: [], next_cursor: '' } } },
    { match: '/rooms', response: { status: 200, body: { rooms: [], next_cursor: '' } } },
  ]);
  await CR.api.listRooms({ cursor: 'abc', limit: 20 });
  await CR.api.listRooms({});
  assert.equal(fetchStub.calls[0].url, 'http://localhost:8080/api/v1/rooms?cursor=abc&limit=20');
  assert.equal(fetchStub.calls[1].url, 'http://localhost:8080/api/v1/rooms', '空参数不应拼出问号');
});

test('POST /rooms：body 是 {name}', async () => {
  const { CR, fetchStub } = setup([{ match: '/rooms', method: 'POST', response: { status: 201, body: { id: 'r9', name: '新房间', member_count: 0 } } }]);
  const room = await CR.api.createRoom('新房间');
  assert.equal(room.id, 'r9');
  assert.deepEqual(fetchStub.calls[0].body, { name: '新房间' });
  assert.equal(fetchStub.calls[0].url, 'http://localhost:8080/api/v1/rooms');
});

test('GET /rooms/{id} 与 /rooms/{id}/members：路径参数会被 URL 编码', async () => {
  const { CR, fetchStub } = setup([
    { match: '/members', response: { status: 200, body: { members: [] } } },
    { match: '/rooms/', response: { status: 200, body: { id: 'r1', name: 'x', member_count: 0 } } },
  ]);
  await CR.api.getRoom('r1');
  await CR.api.roomMembers('r1');
  await CR.api.getRoom('a/b');
  assert.equal(fetchStub.calls[0].url, 'http://localhost:8080/api/v1/rooms/r1');
  assert.equal(fetchStub.calls[1].url, 'http://localhost:8080/api/v1/rooms/r1/members');
  assert.equal(fetchStub.calls[2].url, 'http://localhost:8080/api/v1/rooms/a%2Fb');
});

test('GET /rooms/{id}/messages：before_seq + limit 的字段名一字不差', async () => {
  const { CR, fetchStub } = setup([
    { match: '/messages', response: { status: 200, body: { messages: [], has_more: false } } },
  ]);
  await CR.api.roomMessages('r1', { beforeSeq: '1730000000123-0', limit: 50 });
  assert.equal(
    fetchStub.calls[0].url,
    'http://localhost:8080/api/v1/rooms/r1/messages?before_seq=1730000000123-0&limit=50'
  );
  await CR.api.roomMessages('r1', {});
  assert.match(fetchStub.calls[1].url, /limit=50$/, '没传 limit 时用默认 PAGE_SIZE');
});

test('错误响应：把 {code,message} 原样抛给调用方', async () => {
  const { CR } = setup([{ match: '/rooms', response: { status: 400, body: { code: 'bad_request', message: 'invalid room name' } } }]);
  await assert.rejects(
    () => CR.api.createRoom(''),
    (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.code, 'bad_request');
      assert.equal(err.message, 'invalid room name');
      return true;
    }
  );
});

test('404 与 500（非 JSON body）也能给出可读错误', async () => {
  const { CR } = setup([
    { match: '/rooms/r404', response: { status: 404, body: { code: 'room_not_found', message: 'room_not_found' } } },
    { match: '/rooms/r500', response: { status: 500, body: undefined } },
  ]);
  await assert.rejects(() => CR.api.getRoom('r404'), (e) => e.code === 'room_not_found');
  await assert.rejects(
    () => CR.api.getRoom('r500'),
    (e) => e.code === 'http_500' && e.status === 500
  );
});

test('带鉴权的请求收到 401 → 触发 onUnauthorized（清登录态）', async () => {
  const { CR } = setup([{ match: '/users/me', response: { status: 401, body: { code: 'unauthorized', message: 'invalid or expired token' } } }]);
  let hits = 0;
  CR.api.setOnUnauthorized(() => hits++);
  await assert.rejects(() => CR.api.me(), (e) => e.status === 401);
  assert.equal(hits, 1);
});

test('登录接口自己的 401（密码错）不能触发 onUnauthorized', async () => {
  const { CR } = setup([{ match: '/auth/login', response: { status: 401, body: { code: 'unauthorized', message: 'wrong username or password' } } }]);
  let hits = 0;
  CR.api.setOnUnauthorized(() => hits++);
  await assert.rejects(() => CR.api.login('alice', 'wrong'), (e) => e.message === 'wrong username or password');
  assert.equal(hits, 0, '密码错误不等于登录态失效，不能把人踢回登录页');
});

test('网络层失败（后端没起/跨域被拦）→ code=network_error', async () => {
  const env = createEnv({
    location: REAL_LOCATION,
    fetch: () => Promise.reject(new TypeError('Failed to fetch')),
  });
  const CR = env.load('js/config.js', 'js/store.js', 'js/api.js');
  CR.api.setToken('tok');
  await assert.rejects(
    () => CR.api.listRooms({}),
    (e) => e.code === 'network_error' && e.status === 0
  );
});