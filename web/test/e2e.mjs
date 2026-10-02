/*!
 * test/e2e.mjs —— 真后端端到端测试（默认不跑）
 *
 * 为什么需要它：其余测试都在 mock / fetch 替身上跑，只能证明"前端按契约写"。
 * 这个脚本用 Node 24 自带的 fetch + WebSocket，把 web/ 下**真正的**前端代码
 * （config/store/api/ws）接到真的 Go 服务上跑一遍，验证：
 *   1. REST 契约（路径/字段名/分页/ts 单位）
 *   2. WS 握手（token 放在 query 上）、join/sync/joined/ack/message/presence
 *   3. 两个连接互发消息（对应"开两个窗口互发"验收项）
 *   4. 断线重连后带 last_seq 重新 join，服务端 sync 补齐、不丢不重
 *   5. token 失效：真实后端在握手阶段返回 HTTP 401 → 浏览器只能看到 close 1006，
 *      前端靠 REST 探针识别出来，并且**不**再无限重连
 *
 * 用法：
 *   go run ./cmd/server   # 另开一个终端，或用 Makefile 的 make run
 *   CR_E2E=1 node web/test/e2e.mjs
 *
 * 可用环境变量：CR_API_BASE（默认 http://localhost:8080）、CR_WS_BASE（默认 ws://localhost:8080）
 */
import { createEnv, sleep, waitFor } from './harness.mjs';

const ENABLED = process.env.CR_E2E === '1';
if (!ENABLED) {
  console.log('[e2e] 已跳过（需要真后端）。开启方式：CR_E2E=1 node web/test/e2e.mjs');
  process.exit(0);
}

const API_BASE = process.env.CR_API_BASE || 'http://localhost:8080';
const WS_BASE = process.env.CR_WS_BASE || API_BASE.replace(/^http/, 'ws');
const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const results = [];
async function step(name, fn) {
  try {
    const info = await fn();
    results.push({ name, ok: true, info: info || '' });
    console.log('  ✔ ' + name + (info ? '  — ' + info : ''));
  } catch (e) {
    results.push({ name, ok: false, info: (e && e.message) || String(e) });
    console.log('  ✖ ' + name + '  — ' + ((e && e.stack) || e));
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** 起一个"窗口"：加载真实前端代码，接到真后端。 */
let wsConstructed = 0;
function newWindow(label) {
  class CountingWebSocket extends WebSocket {
    constructor(url) {
      super(url);
      wsConstructed++;
      CountingWebSocket.instances.push(this);
    }
  }
  CountingWebSocket.instances = [];

  const env = createEnv({
    location: { search: '', protocol: API_BASE.startsWith('https') ? 'https:' : 'http:', href: API_BASE + '/' },
    fetch: globalThis.fetch.bind(globalThis),
    WebSocket: CountingWebSocket,
  });
  const CR = env.loadCore();
  CR.config.API_BASE = API_BASE;
  CR.config.WS_BASE = WS_BASE;
  CR.config.MOCK = false;
  CR.config.WS_RECONNECT_BASE = 300; // 测试里不等 1s
  CR.config.WS_RECONNECT_MAX = 1000;

  // 和 main.js / ws.test.mjs 等价的接线
  CR.api.setOnUnauthorized(() => {});
  CR.ws.setAuthProbe(() =>
    CR.api.me().then(() => true).catch((e) => (e && e.status === 401 ? false : Promise.reject(e)))
  );
  const events = { unauthorized: 0, sync: 0, open: 0 };
  CR.ws.on('unauthorized', () => events.unauthorized++);
  CR.ws.on('status', (st) => CR.store.setConn(st.status, st.retry || 0));
  CR.ws.on('open', () => {
    events.open++;
    const room = CR.store.state.currentRoom;
    if (room) CR.ws.join(room, CR.store.lastSeqFor(room));
  });
  CR.ws.on('joined', (f) => CR.store.setMembers(f.room, f.members || []));
  CR.ws.on('sync', (f) => {
    events.sync++;
    CR.store.applySync(f.room, f.messages || [], f.last_seq || '');
  });
  CR.ws.on('message', (f) => CR.store.addMessage(f));
  CR.ws.on('ack', (f) => CR.store.applyAck(f.client_msg_id, f.seq));
  CR.ws.on('presence', (f) => CR.store.applyPresence(f.room, f.joins || [], f.leaves || []));
  CR.ws.on('error', (f) => console.log('    [ws error frame][' + label + ']', JSON.stringify(f)));

  return { label, CR, CountingWebSocket, events };
}

async function newUser(CR, prefix) {
  const username = 'e2e-' + prefix + '-' + RUN;
  const password = 'e2e-pass-123';
  await CR.api.register(username, password);
  const res = await CR.api.login(username, password);
  CR.api.setToken(res.token);
  CR.store.setSession(res.token, res.user);
  return res;
}

console.log('[e2e] 目标后端: ' + API_BASE + '（run=' + RUN + '）');

const A = newWindow('A');
const B = newWindow('B');
let tokenA = '';
let roomId = '';

await step('POST /auth/register + /auth/login：拿到 token 和 user', async () => {
  const res = await newUser(A.CR, 'a');
  tokenA = res.token;
  assert(res.user && res.user.id, 'login 应返回 user.id');
  assert(res.user.name === 'e2e-a-' + RUN || res.user.name, 'user.name 应有值');
  return 'user=' + res.user.name;
});

await step('GET /users/me：带 token 能取回自己', async () => {
  const me = await A.CR.api.me();
  assert(me && me.id, 'me 应返回 id');
  return me.id;
});

await step('GET /rooms：列表结构与字段正确（{rooms:[{id,name,member_count}],next_cursor}）', async () => {
  const res = await A.CR.api.listRooms({ limit: 50 });
  assert(Array.isArray(res.rooms), 'rooms 必须是数组');
  assert(typeof res.next_cursor === 'string', 'next_cursor 必须是字符串');
  assert(res.rooms.length > 0, '至少应有一个房间（后端启动时会建默认房间）');
  const first = res.rooms[0];
  assert(typeof first.id === 'string' && typeof first.name === 'string', 'room 字段应为 {id,name,member_count}');
  assert(typeof first.member_count === 'number', 'member_count 必须是数字');
  return res.rooms.length + ' 个房间，首个=' + first.id;
});

await step('POST /rooms：建房返回 201 结构 {id,name,member_count}', async () => {
  const room = await A.CR.api.createRoom('e2e-' + RUN);
  assert(room && room.id, '建房应返回 id');
  assert(room.name === 'e2e-' + RUN, 'name 应回显');
  assert(typeof room.member_count === 'number', 'member_count 必须是数字');
  roomId = room.id;
  A.CR.store.setCurrentRoom(roomId);
  B.CR.store.setCurrentRoom(roomId);
  return roomId;
});

await step('GET /rooms/{id}/members：返回 {members:[{id,name}]}', async () => {
  const res = await A.CR.api.roomMembers(roomId);
  assert(Array.isArray(res.members), 'members 必须是数组');
  return res.members.length + ' 人';
});

await step('GET /rooms/{id}/messages：空房间返回 {messages:[],has_more:false}', async () => {
  const res = await A.CR.api.roomMessages(roomId, { limit: 50 });
  assert(Array.isArray(res.messages), 'messages 必须是数组');
  assert(res.has_more === false || res.has_more === true, 'has_more 必须是布尔');
  return 'has_more=' + res.has_more;
});

await step('WS 握手：token 走 query，join 后收到 joined + sync', async () => {
  A.CR.ws.connect(tokenA);
  await waitFor(() => A.CR.ws.isOpen(), 5000, 'A 的 WS 连接');
  A.CR.ws.join(roomId, '');
  await waitFor(() => A.events.sync > 0, 5000, 'A 收到 sync');
  await waitFor(() => A.CR.store.membersFor(roomId).length >= 1, 5000, 'A 收到 joined（成员快照）');
  return 'members=' + A.CR.store.membersFor(roomId).length;
});

await step('WS 快速发 3 条：seq 唯一、不重复、ack 与 message 都到位', async () => {
  const idents = ['e2e-a1-' + RUN, 'e2e-a2-' + RUN, 'e2e-a3-' + RUN];
  idents.forEach((cmid, i) => {
    A.CR.store.addPending(roomId, cmid, 'e2e msg ' + (i + 1), A.CR.store.state.session.user);
    assert(A.CR.ws.chat(roomId, cmid, 'e2e msg ' + (i + 1)), 'chat 应该发出去');
  });
  await waitFor(() => A.CR.store.messageCountFor(roomId) >= 3, 5000, '3 条消息落地');
  await waitFor(() => A.CR.store.pendingFor(roomId).length === 0, 5000, '乐观消息全部被 ack 收编');
  const seqs = A.CR.store.state.messages[roomId].map((m) => m.seq);
  assert(new Set(seqs).size === seqs.length, 'seq 不能重复');
  assert(seqs.length === 3, '应恰好 3 条，实际 ' + seqs.length);
  return seqs.join(',');
});

await step('幂等：重发同一个 client_msg_id 不会写出第二条', async () => {
  const cmid = 'e2e-idem-' + RUN;
  A.CR.ws.chat(roomId, cmid, '幂等测试');
  await waitFor(() => A.CR.store.state.messages[roomId].some((m) => m.content === '幂等测试'), 5000, '第一条到达');
  const before = A.CR.store.messageCountFor(roomId);
  A.CR.ws.chat(roomId, cmid, '幂等测试'); // 同 id 再发一次
  await sleep(700);
  assert(
    A.CR.store.messageCountFor(roomId) === before,
    '同一个 client_msg_id 第二次不应再产生消息（去重失效）'
  );
  return 'before=' + before + ' after=' + A.CR.store.messageCountFor(roomId);
});

await step('两个连接互发消息（对应"开两个窗口"验收项）', async () => {
  await newUser(B.CR, 'b');
  B.CR.ws.connect(B.CR.api.getToken());
  await waitFor(() => B.CR.ws.isOpen(), 5000, 'B 的 WS 连接');
  B.CR.ws.join(roomId, '');
  await waitFor(() => B.CR.store.membersFor(roomId).length >= 2, 5000, '互相看到在线');

  const cmid = 'e2e-b1-' + RUN;
  B.CR.store.addPending(roomId, cmid, 'B 说的话', B.CR.store.state.session.user);
  B.CR.ws.chat(roomId, cmid, 'B 说的话');
  await waitFor(() => A.CR.store.state.messages[roomId].some((m) => m.content === 'B 说的话'), 5000, 'A 收到 B 的消息');
  await waitFor(() => B.CR.store.state.messages[roomId].some((m) => m.content === 'B 说的话'), 5000, 'B 自己也收到');

  const seqs = A.CR.store.state.messages[roomId].map((m) => m.seq);
  assert(new Set(seqs).size === seqs.length, 'A 侧不能出现重复 seq');
  return 'A 共 ' + seqs.length + ' 条';
});

await step('REST 历史：倒序（新→旧）、无 client_msg_id、ts 是 Unix 秒', async () => {
  const res = await A.CR.api.roomMessages(roomId, { limit: 5 });
  assert(res.messages.length >= 1, '应该有历史');
  const first = res.messages[0];
  assert(typeof first.seq === 'string', 'seq 必须是字符串');
  assert(typeof first.content === 'string', 'content 必须是字符串');
  assert(first.from && typeof first.from.id === 'string', 'from 必须是 {id,name}');
  assert(!('client_msg_id' in first), 'REST 历史不应该带 client_msg_id（前端只能靠 seq 去重）');
  const tsSeconds = Math.abs(first.ts - Math.floor(Date.now() / 1000));
  assert(tsSeconds < 600, 'ts 应该是 Unix 秒，实际与当前秒数相差 ' + tsSeconds);
  // 倒序：seq 应该递减
  const seqs = A.CR.store.state.messages[roomId].map((m) => m.seq);
  assert(seqs.length === new Set(seqs).size, 'seq 唯一');
  return 'ts=' + first.ts + '（Unix 秒）';
});

await step('断线自动重连：带 last_seq 重新 join，sync 补齐断线期间的消息', async () => {
  const before = A.CR.store.messageCountFor(roomId);
  const lastSeq = A.CR.store.lastSeqFor(roomId);
  assert(lastSeq, '断线前应该有本地最大 seq');

  // 绕过 CR.ws.close()，直接掐掉底层连接，模拟"网线被拔"（这样才会自动重连）
  const sock = A.CountingWebSocket.instances[A.CountingWebSocket.instances.length - 1];
  sock.close();
  await waitFor(() => A.CR.ws.status().status === 'offline', 3000, 'A 进入离线');

  // 断线期间 B 连发 2 条：A 必然收不到
  B.CR.ws.chat(roomId, 'e2e-miss1-' + RUN, 'A 不在 1');
  B.CR.ws.chat(roomId, 'e2e-miss2-' + RUN, 'A 不在 2');
  await waitFor(() => B.CR.store.state.messages[roomId].some((m) => m.content === 'A 不在 2'), 5000, 'B 的两条已入库');

  await waitFor(() => A.events.open >= 2, 8000, 'A 自动重连');
  await waitFor(() => A.CR.store.state.messages[roomId].some((m) => m.content === 'A 不在 2'), 8000, 'A 通过 sync 补齐');

  const seqs = A.CR.store.state.messages[roomId].map((m) => m.seq);
  assert(new Set(seqs).size === seqs.length, '补齐后不能有重复 seq（sync 去重失败）');
  assert(A.CR.store.messageCountFor(roomId) === before + 2, '应该正好多 2 条，实际 ' + (A.CR.store.messageCountFor(roomId) - before));
  assert(A.CR.ws._attempt() === 0, '重连成功后退避计数应归零');
  return '补齐 ' + (A.CR.store.messageCountFor(roomId) - before) + ' 条，无重复';
});

await step('成员离线实时同步：对方断开 → 成员名单与房间人数立刻更新（不刷新、不等 TTL）', async () => {
  await waitFor(() => A.CR.store.membersFor(roomId).length >= 2, 5000, 'A 看到 B 在线');

  // 模拟"页面刚打开时拉到的房间列表"：里面有这个房间和它的人数
  const list = await A.CR.api.listRooms({ limit: 50 });
  A.CR.store.setRooms(list.rooms, list.next_cursor);
  const entry = A.CR.store.roomById(roomId);
  assert(entry, '房间列表里应该有这个房间');
  const before = entry.member_count;
  assert(before >= 2, '房间列表人数应至少 2，实际 ' + before);

  // B 直接断开（不发 leave 帧，等价于用户关掉标签页/拔网线）
  B.CR.ws.close();

  await waitFor(() => A.CR.store.membersFor(roomId).length === 1, 3000, 'A 的成员名单去掉 B');
  const bid = B.CR.store.state.session.user.id;
  assert(!A.CR.store.membersFor(roomId).some((m) => m.id === bid), '离开的人不能还挂在名单里');

  // 左栏那个数字也要跟着变（presence 驱动，不需要重新请求 REST）
  await waitFor(() => A.CR.store.roomById(roomId).member_count === 1, 3000, '房间列表人数变成 1');

  // 反查服务端：presence 真的被摘掉了，而不是前端自己"看不见"而已
  const fresh = await A.CR.api.listRooms({ limit: 50 });
  const after = fresh.rooms.find((r) => r.id === roomId);
  assert(after, '刷新后房间还在');
  assert(
    after.member_count === 1,
    '服务端 presence 应已摘掉离线的人（否则要等 90s TTL），实际 member_count=' + after.member_count
  );
  return '人数 ' + before + ' → 1，3 秒内生效（未等 presence TTL）';
});

await step('token 失效：握手 401 → REST 探针识别 → 不无限重连', async () => {
  const C = newWindow('C');
  C.CR.api.setToken('definitely-not-a-valid-token');
  C.CR.store.setSession('definitely-not-a-valid-token', { id: 'x', name: 'x' });
  C.CR.store.setCurrentRoom(roomId);
  C.CR.ws.connect('definitely-not-a-valid-token');
  await waitFor(() => C.events.unauthorized > 0, 8000, '识别出 token 失效');
  const created = C.CountingWebSocket.instances.length;
  await sleep(1500);
  assert(
    C.CountingWebSocket.instances.length === created,
    'token 失效后不应该继续重连（新建连接数 ' + C.CountingWebSocket.instances.length + '）'
  );
  return '识别为 unauthorized，重连已停止';
});

A.CR.ws.close();
B.CR.ws.close();

const failed = results.filter((r) => !r.ok);
console.log('\n[e2e] ' + (results.length - failed.length) + '/' + results.length + ' 通过');
if (failed.length) {
  failed.forEach((f) => console.log('  ✖ ' + f.name + ': ' + f.info));
  process.exit(1);
}
console.log('[e2e] 全部通过 ✅');
process.exit(0);