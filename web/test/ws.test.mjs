/*!
 * test/ws.test.mjs —— 连接层与"可靠性交互"的集成测试
 *
 * 用 mock 假后端（进程内）跑真实的 ws.js + store.js 代码路径，覆盖：
 *   - 断线自动重连 + 带 last_seq 重新 join + sync 补拉后"不丢不重"
 *   - 连续快速发 10 条，全部只出现一次
 *   - Close 4001 → 不重连；握手失败 + REST 探针 401 → 不重连（真实后端就是这么返回的）
 *   - 退避序列 1s→2s→4s…封顶 + ±20% 抖动
 *   - 未读数
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEnv,
  createSharedBus,
  createStorage,
  createWebSocketStub,
  plain,
  sleep,
  waitFor,
} from './harness.mjs';

const MOCK_LOCATION = { search: '?mock=1', protocol: 'http:', href: 'http://localhost:5173/?mock=1' };

/**
 * 每个用例都把 CR 登记下来，跑完统一 close()。
 * 否则"一直在失败重连"的用例会留下永不停止的定时器，让测试进程不退出。
 */
const opened = [];
function track(CR) {
  opened.push(CR);
  return CR;
}
after(() => {
  opened.forEach((CR) => {
    try {
      if (CR.ws) CR.ws.close();
    } catch (e) {
      /* ignore */
    }
  });
});

/** 和 main.js 里等价的接线（测试不加载 DOM，所以自己接一遍）。 */
function wireApp(CR, room) {
  CR.ws.on('status', (st) => CR.store.setConn(st.status, st.retry || 0));
  CR.ws.on('open', () => CR.ws.join(room, CR.store.lastSeqFor(room)));
  CR.ws.on('joined', (f) => CR.store.setMembers(f.room, f.members || []));
  CR.ws.on('sync', (f) => CR.store.applySync(f.room, f.messages || [], f.last_seq || ''));
  CR.ws.on('message', (f) => CR.store.addMessage(f));
  CR.ws.on('ack', (f) => CR.store.applyAck(f.client_msg_id, f.seq));
  CR.ws.on('presence', (f) => CR.store.applyPresence(f.room, f.joins || [], f.leaves || []));
  CR.ws.on('typing', (f) => {
    if (f.room) CR.store.setTyping(f.room, f.from);
  });
}

async function loginMock(CR, username, password) {
  const res = await CR.api.login(username, password);
  CR.api.setToken(res.token);
  CR.store.setSession(res.token, res.user);
  return res;
}

function makeMockEnv(opts = {}) {
  const env = createEnv(Object.assign({ location: MOCK_LOCATION }, opts));
  const CR = track(env.loadCore());
  CR.config.MOCK_LATENCY_MIN = 1;
  CR.config.MOCK_LATENCY_MAX = 3;
  CR.config.MOCK_AUTO_DEMO = false;
  CR.config.WS_RECONNECT_BASE = 10;
  CR.config.WS_RECONNECT_MAX = 40;
  CR.mock.setAutoDemo(false);
  track(CR);
  return { env, CR };
}

test('mock 模式：登录取到的 token 能连上，join 后拿到 joined/sync', async () => {
  const { CR } = makeMockEnv();
  await loginMock(CR, 'alice', 'alice123');
  wireApp(CR, 'r1');
  CR.store.setCurrentRoom('r1');
  CR.ws.connect(CR.api.getToken());

  await waitFor(() => CR.ws.isOpen(), 2000, '连接建立');
  await waitFor(() => CR.store.membersFor('r1').length >= 2, 2000, 'joined 成员快照');
  assert.ok(CR.store.messageCountFor('r1') >= 2, 'sync 应该把预置历史补进来');
});

test('连续快速发 10 条：全部只出现一次，乐观消息全部被替换', async () => {
  const { CR } = makeMockEnv();
  await loginMock(CR, 'alice', 'alice123');
  wireApp(CR, 'r1');
  CR.store.setCurrentRoom('r1');
  CR.ws.connect(CR.api.getToken());
  await waitFor(() => CR.ws.isOpen(), 2000, '连接建立');
  await waitFor(() => CR.store.membersFor('r1').length > 0, 2000, 'joined');

  const base = CR.store.messageCountFor('r1');
  const cmids = [];
  for (let i = 1; i <= 10; i++) {
    const cmid = 'rapid-' + i;
    cmids.push(cmid);
    CR.store.addPending('r1', cmid, '消息 ' + i, CR.store.state.session.user);
    assert.equal(CR.ws.chat('r1', cmid, '消息 ' + i), true);
  }
  assert.equal(CR.store.pendingFor('r1').length, 10, '10 条都先乐观上屏');

  await waitFor(() => CR.store.messageCountFor('r1') === base + 10, 4000, '10 条都落到消息流');
  await waitFor(() => CR.store.pendingFor('r1').length === 0, 4000, '占位全部被服务端消息替换');

  const seqs = CR.store.state.messages.r1.map((m) => m.seq);
  assert.equal(new Set(seqs).size, seqs.length, 'seq 不能重复');
  const contents = CR.store.state.messages.r1.slice(-10).map((m) => m.content);
  assert.deepEqual(plain(contents), cmids.map((_, i) => '消息 ' + (i + 1)));
});

test('断线重连：重连后带 last_seq 重新 join，漏掉的消息由 sync 补齐且不重复', async () => {
  const storage = createStorage();
  const busHub = createSharedBus();

  // A 窗口（重连基数调大，让断线窗口足够长，确定能走到 sync 补拉分支）
  const a = makeMockEnv({ storage });
  a.CR.config.WS_RECONNECT_BASE = 120;
  a.CR.config.WS_RECONNECT_MAX = 120;
  a.CR.mock.useBus(busHub.createEndpoint());
  const sentFrames = [];
  const createSocket = a.CR.mock.createSocket;
  a.CR.mock.createSocket = (url) => {
    const s = createSocket(url);
    const rawSend = s.send.bind(s);
    s.send = (text) => {
      sentFrames.push(JSON.parse(text));
      rawSend(text);
    };
    return s;
  };
  await loginMock(a.CR, 'alice', 'alice123');
  wireApp(a.CR, 'r1');
  a.CR.store.setCurrentRoom('r1');
  a.CR.ws.connect(a.CR.api.getToken());
  await waitFor(() => a.CR.ws.isOpen(), 2000, 'A 连接建立');
  await waitFor(() => a.CR.store.messageCountFor('r1') >= 2, 2000, 'A 拿到历史');

  // B 窗口：另一个用户
  const b = makeMockEnv({ storage });
  b.CR.mock.useBus(busHub.createEndpoint());
  await loginMock(b.CR, 'bob', 'bob12345');
  wireApp(b.CR, 'r1');
  b.CR.store.setCurrentRoom('r1');
  b.CR.ws.connect(b.CR.api.getToken());
  await waitFor(() => b.CR.ws.isOpen(), 2000, 'B 连接建立');
  await waitFor(() => b.CR.store.membersFor('r1').length >= 2, 2000, 'B 看到彼此在线');

  // A 说一句，B 应该通过总线收到（跨窗口）
  const beforeA = a.CR.store.messageCountFor('r1');
  const cmid = 'cross-1';
  a.CR.store.addPending('r1', cmid, 'hi from A', a.CR.store.state.session.user);
  a.CR.ws.chat('r1', cmid, 'hi from A');
  await waitFor(() => a.CR.store.messageCountFor('r1') === beforeA + 1, 2000, 'A 收到自己的消息');
  await waitFor(() => b.CR.store.state.messages.r1.some((m) => m.content === 'hi from A'), 2000, 'B 跨窗口收到');

  // 断掉 A；断线期间 B 连发 2 条 → A 必然漏收
  const lastSeqBeforeDrop = a.CR.store.lastSeqFor('r1');
  const dropped = a.CR.mock.simulateDrop();
  assert.equal(dropped, 1);
  await waitFor(() => a.CR.ws.status().status === 'offline', 1000, 'A 进入离线状态');
  const bBase = b.CR.store.messageCountFor('r1');
  b.CR.ws.chat('r1', 'while-down-1', 'A 不在时的第一条');
  b.CR.ws.chat('r1', 'while-down-2', 'A 不在时的第二条');
  await waitFor(() => b.CR.store.messageCountFor('r1') === bBase + 2, 2000, 'B 的两条已经入库');

  // A 自动重连：应带 last_seq 重新 join，并用 sync 补齐
  await waitFor(() => a.CR.ws.isOpen(), 3000, 'A 自动重连成功');
  await waitFor(
    () => a.CR.store.state.messages.r1.some((m) => m.content === 'A 不在时的第二条'),
    3000,
    'A 补齐断线期间的消息'
  );

  const seqs = a.CR.store.state.messages.r1.map((m) => m.seq);
  assert.equal(new Set(seqs).size, seqs.length, 'A 的消息流里不能有重复 seq');
  const lastJoin = sentFrames.filter((f) => f.type === 'join').pop();
  assert.ok(lastJoin, '重连后应该重新发 join');
  assert.equal(
    lastJoin.last_seq,
    lastSeqBeforeDrop,
    '重连时的 join 必须带断线前本地最大 seq，sync 才能只补漏掉的那几条'
  );
  assert.equal(a.CR.ws._attempt(), 0, '连接成功后退避计数归零');
});

test('Close 4001：不重连，回调 unauthorized', async () => {
  const FakeWS = createWebSocketStub();
  const env = createEnv({ WebSocket: FakeWS });
  const CR = track(env.loadCore());
  CR.config.WS_RECONNECT_BASE = 5;
  CR.config.WS_RECONNECT_MAX = 10;

  let unauthorized = 0;
  CR.ws.on('unauthorized', () => unauthorized++);
  CR.ws.connect('bad-token');
  assert.equal(FakeWS.created.length, 1);
  FakeWS.created[0]._serverClose(4001, 'unauthorized');

  await waitFor(() => unauthorized === 1, 500, 'unauthorized 回调');
  await sleep(80);
  assert.equal(FakeWS.created.length, 1, '4001 之后绝不能重连');
  assert.equal(CR.ws.status().status, 'unauthorized');
});

test('握手失败 + REST 探针返回 401：判定 token 失效，不重连', async () => {
  const FakeWS = createWebSocketStub({
    onCreated: (sock) => setTimeout(() => sock._serverClose(1006, 'unexpected response: 401'), 0),
  });
  const env = createEnv({ WebSocket: FakeWS });
  const CR = track(env.loadCore());
  CR.config.WS_RECONNECT_BASE = 5;
  CR.ws.setAuthProbe(() => Promise.resolve(false)); // 探针说 token 无效

  let unauthorized = 0;
  CR.ws.on('unauthorized', () => unauthorized++);
  CR.ws.connect('expired');
  await waitFor(() => unauthorized === 1, 500, 'unauthorized 回调');
  await sleep(60);
  assert.equal(FakeWS.created.length, 1, 'token 失效不该无限重连');
});

test('握手失败 + 探针网络异常：当作网络问题，继续按退避重连', async () => {
  const FakeWS = createWebSocketStub({
    onCreated: (sock) => setTimeout(() => sock._serverClose(1006, 'connection refused'), 0),
  });
  const env = createEnv({ WebSocket: FakeWS });
  const CR = track(env.loadCore());
  CR.config.WS_RECONNECT_BASE = 5;
  CR.config.WS_RECONNECT_MAX = 10;
  CR.ws.setAuthProbe(() => Promise.reject(new Error('network down')));

  CR.ws.connect('good-token');
  await waitFor(() => FakeWS.created.length >= 3, 1000, '持续重连');
  assert.equal(CR.ws.status().status, 'offline');
  assert.ok(CR.ws.status().retry >= 1);
});

test('退避序列：基数翻倍直到封顶，且抖动不超过 ±20%', async () => {
  const stamps = [];
  const FakeWS = createWebSocketStub({
    onCreated: (sock) => {
      stamps.push(Date.now());
      setTimeout(() => sock._serverClose(1006, 'boom'), 0);
    },
  });
  const env = createEnv({ WebSocket: FakeWS });
  const CR = track(env.loadCore());
  CR.config.WS_RECONNECT_BASE = 20;
  CR.config.WS_RECONNECT_MAX = 80;
  CR.config.WS_JITTER = 0.2;
  CR.ws.setAuthProbe(() => Promise.resolve(true)); // token 有效 → 走重连分支

  CR.ws.connect('tok');
  await waitFor(() => stamps.length >= 5, 3000, '连续失败 5 次');

  const deltas = [];
  for (let i = 1; i < stamps.length; i++) deltas.push(stamps[i] - stamps[i - 1]);
  assert.ok(deltas.length >= 3, '至少能量到 3 段间隔，实际 ' + deltas.length);
  const expects = [20, 40, 80, 80]; // 20 → 40 → 80 → 封顶 80
  deltas.slice(0, 4).forEach((d, i) => {
    const want = expects[Math.min(i, expects.length - 1)];
    assert.ok(
      d >= want * 0.8 - 5 && d <= want * 1.2 + 30,
      `第 ${i + 1} 段退避 ${d}ms 不在 ${want}ms ±20% 附近（抖动或未封顶）`
    );
  });
});

test('未读数：其它房间来消息时角标 +1（mock 演示路径）', async () => {
  const { CR } = makeMockEnv();
  await loginMock(CR, 'alice', 'alice123');
  wireApp(CR, 'r1');
  CR.store.setCurrentRoom('r1');
  CR.ws.connect(CR.api.getToken());
  await waitFor(() => CR.ws.isOpen(), 2000, '连接建立');
  await waitFor(() => CR.store.membersFor('r1').length > 0, 2000, 'joined');

  const r1Count = CR.store.messageCountFor('r1');
  CR.mock.demoOtherRoomMessage('r1');
  await waitFor(() => CR.store.unreadFor('r2') === 1, 1000, 'r2 未读 +1');
  assert.equal(CR.store.messageCountFor('r1'), r1Count, '其它房间的消息不进当前消息流');
  assert.equal(CR.store.messageCountFor('r2'), 1);
  CR.store.setCurrentRoom('r2');
  assert.equal(CR.store.unreadFor('r2'), 0, '切过去要清零');
});

test('没 join 就发言：服务端回 4002，前端能收到 error 帧', async () => {
  const { CR } = makeMockEnv();
  await loginMock(CR, 'alice', 'alice123');
  const errs = [];
  CR.ws.on('error', (f) => errs.push(f));
  CR.ws.connect(CR.api.getToken());
  await waitFor(() => CR.ws.isOpen(), 2000, '连接建立');

  CR.ws.chat('r1', 'nojoin-1', '还没进房间');
  await waitFor(() => errs.some((e) => e.code === 4002), 2000, '收到 4002');
  assert.equal(errs.find((e) => e.code === 4002).ref, 'nojoin-1', 'error.ref 要带上是哪条消息');
});

test('typing：别人的正在输入会显示，自己的忽略', async () => {
  const storage = createStorage();
  const busHub = createSharedBus();

  const a = makeMockEnv({ storage });
  a.CR.mock.useBus(busHub.createEndpoint());
  await loginMock(a.CR, 'alice', 'alice123');
  wireApp(a.CR, 'r1');
  a.CR.store.setCurrentRoom('r1');
  a.CR.ws.connect(a.CR.api.getToken());
  await waitFor(() => a.CR.ws.isOpen(), 2000, 'A 连接建立');
  await waitFor(() => a.CR.store.membersFor('r1').length > 0, 2000, 'A joined');

  const b = makeMockEnv({ storage });
  b.CR.mock.useBus(busHub.createEndpoint());
  await loginMock(b.CR, 'bob', 'bob12345');
  wireApp(b.CR, 'r1');
  b.CR.store.setCurrentRoom('r1');
  b.CR.ws.connect(b.CR.api.getToken());
  await waitFor(() => b.CR.ws.isOpen(), 2000, 'B 连接建立');
  await waitFor(() => b.CR.store.membersFor('r1').length >= 2, 2000, '互相看到在线');

  b.CR.ws.typing('r1');
  await waitFor(() => a.CR.store.typingLabel('r1') !== '', 2000, 'A 看到"正在输入"');
  assert.match(a.CR.store.typingLabel('r1'), /bob/i);
  assert.equal(b.CR.store.typingLabel('r1'), '', '自己的 typing 不该显示给自己');

  a.CR.store.clearTyping('r1');
  assert.equal(a.CR.store.typingLabel('r1'), '', '3 秒后自动消失（这里手动验证清除路径）');
});
