/*!
 * test/store.test.mjs —— 可靠性逻辑单测（不碰 DOM、不碰网络）
 *
 * 覆盖 guide 8.2 里最容易出错的几条：seq 去重、乐观消息三态、ack 超时重试、
 * sync 合并、未读数、以及"切房间来回时不要重复渲染"的对账逻辑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, plain, sleep } from './harness.mjs';

function freshStore() {
  const env = createEnv();
  const CR = env.load('js/config.js', 'js/store.js');
  CR.store.setSession('tok', { id: 'me', name: '我' });
  return { CR, store: CR.store, state: CR.store.state };
}

test('compareSeq：不同位数的时间戳也按时间序，而不是词典序', () => {
  const { CR } = freshEnv();
  const c = CR.util.compareSeq;
  assert.equal(c('1000-0', '1000-0'), 0);
  assert.ok(c('999-0', '1000-0') < 0, '"999-0" 应该小于 "1000-0"（词典序会判反）');
  assert.ok(c('1000-2', '1000-10') < 0, '同一毫秒内按序号数值比较');
  assert.ok(c('1730000000123-0', '1730000000124-0') < 0);
});

function freshEnv() {
  const env = createEnv();
  const CR = env.load('js/config.js', 'js/store.js');
  return { CR, env };
}

test('addMessage：同一个 seq 只渲染一次', () => {
  const { store, state } = freshStore();
  const msg = { room: 'r1', seq: '100-0', from: { id: 'u1', name: 'A' }, content: 'hi', ts: 100 };
  assert.equal(store.addMessage(msg), 'added');
  assert.equal(store.addMessage(msg), 'dup');
  assert.equal(store.messageCountFor('r1'), 1);
  assert.equal(state.messages.r1[0].content, 'hi');
});

test('乐观消息：ack 标记已发送，随后到达的 message 用 cmid 替换占位而不是新增', () => {
  const { store, state } = freshStore();
  const cmid = 'cmid-1';
  store.addPending('r1', cmid, '你好', { id: 'me', name: '我' });
  assert.equal(store.pendingFor('r1').length, 1);
  assert.equal(store.pendingFor('r1')[0].status, 'sending');

  assert.equal(store.applyAck(cmid, '200-0'), true);
  assert.equal(store.pendingFor('r1')[0].status, 'sent');

  const result = store.addMessage({
    room: 'r1',
    seq: '200-0',
    client_msg_id: cmid,
    from: { id: 'me', name: '我' },
    content: '你好',
    ts: 101,
  });
  assert.equal(result, 'replaced');
  assert.equal(store.pendingFor('r1').length, 0, '占位消息应该被摘掉');
  assert.equal(store.messageCountFor('r1'), 1, '不能变成两条');
  assert.equal(store.lastSeqFor('r1'), '200-0');
});

test('ack 超时 → 标记失败 → 重试复用同一个 client_msg_id', () => {
  const { store, state } = freshStore();
  store.addPending('r1', 'cmid-x', 'hi', { id: 'me', name: '我' });
  const createdAt = store.pendingFor('r1')[0].createdAt;

  assert.deepEqual(plain(store.sweepTimeouts(10000, createdAt + 9999)), [], '未超时不动它');
  const expired = store.sweepTimeouts(10000, createdAt + 10001);
  assert.deepEqual(plain(expired), ['cmid-x']);
  assert.equal(store.pendingFor('r1')[0].status, 'failed');

  const retry = store.retryPending('cmid-x');
  assert.equal(retry.clientMsgId, 'cmid-x', '重试必须复用同一个 id（否则服务端会写两条）');
  assert.equal(retry.content, 'hi');
  assert.equal(store.pendingFor('r1')[0].status, 'sending');
});

test('applySync：按 seq 去重合并，重叠部分不重复', () => {
  const { store } = freshStore();
  store.setHistory('r1', [
    { seq: '1-0', from: { id: 'a' }, content: 'a', ts: 1 },
    { seq: '2-0', from: { id: 'a' }, content: 'b', ts: 2 },
  ]);
  const added = store.applySync(
    'r1',
    [
      { seq: '2-0', from: { id: 'a' }, content: 'b', ts: 2 },
      { seq: '3-0', from: { id: 'a' }, content: 'c', ts: 3 },
      { seq: '4-0', from: { id: 'a' }, content: 'd', ts: 4 },
    ],
    '4-0'
  );
  assert.equal(added, 2, '只有 3-0 / 4-0 是新的');
  assert.equal(store.messageCountFor('r1'), 4);
  assert.equal(store.lastSeqFor('r1'), '4-0');
});

test('setHistory 是并集：翻页加载过的更早消息不会被新的一页冲掉', () => {
  const { store } = freshStore();
  store.setHistory('r1', [
    { seq: '1-0', content: 'old', ts: 1 },
    { seq: '2-0', content: 'mid', ts: 2 },
  ]);
  store.setHistory('r1', [
    { seq: '2-0', content: 'mid', ts: 2 },
    { seq: '3-0', content: 'new', ts: 3 },
  ]);
  assert.equal(store.messageCountFor('r1'), 3);
  assert.deepEqual(plain(store.state.messages.r1.map((m) => m.seq)), ['1-0', '2-0', '3-0']);
});

test('切房间来回：已经进了历史的乐观消息会被对账掉，不重复渲染', async () => {
  const { store } = freshStore();
  store.addPending('r1', 'cmid-r', '重复', { id: 'me', name: '我' });
  store.applyAck('cmid-r', '');
  const pendingTs = store.pendingFor('r1')[0].ts;

  await sleep(5);
  // 模拟重新进入房间拉到历史：REST 历史里没有 client_msg_id，只能靠内容+时间对账
  store.setHistory('r1', [
    { seq: '300-0', from: { id: 'me', name: '我' }, content: '重复', ts: pendingTs },
  ]);
  assert.equal(store.pendingFor('r1').length, 0, '同一条消息不该既在历史又在待发列表里');
  const timeline = store.timelineFor('r1');
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].kind, 'message');
});

test('历史先到、ack 后到：重复 seq 也要认领掉乐观占位（不能重复渲染）', () => {
  const { store } = freshStore();
  const me = { id: 'me', name: '我' };
  store.addPending('r1', 'c1', 'hi', me);
  const ts = store.pendingFor('r1')[0].ts;

  // 竞态：REST 历史先拿到（服务端其实已经写入），此时 ack 还没回来 → 状态还是 sending
  store.setHistory('r1', [{ seq: '10-0', from: me, content: 'hi', ts }]);
  assert.equal(store.pendingFor('r1').length, 0, '历史里已经有它，占位就该消失');
  assert.equal(store.messageCountFor('r1'), 1);

  // 紧接着 WS 的 message 帧到达，seq 已存在 → dup，且不能又冒出一条
  assert.equal(
    store.addMessage({ room: 'r1', seq: '10-0', client_msg_id: 'c1', from: me, content: 'hi', ts }),
    'dup'
  );
  assert.equal(store.timelineFor('r1').length, 1, '界面上只应该有一条');
  assert.equal(store.pendingFor('r1').length, 0);
});

test('连发两条相同内容：一条历史只抵消一条占位（不能把未确认的也吃掉）', () => {
  const { store } = freshStore();
  const me = { id: 'me', name: '我' };
  store.addPending('r1', 'a', 'ok', me);
  store.addPending('r1', 'b', 'ok', me);
  const ts = store.pendingFor('r1')[0].ts;

  store.setHistory('r1', [{ seq: '1-0', from: me, content: 'ok', ts }]);
  const left = store.pendingFor('r1');
  assert.equal(left.length, 1, '只有第一条被历史认领');
  assert.equal(left[0].clientMsgId, 'b');
});

test('未读数：非当前房间的消息 +1，切过去清零', () => {
  const { store, state } = freshStore();
  store.setCurrentRoom('r1');
  store.addMessage({ room: 'r2', seq: '1-0', content: 'x', ts: 1 });
  store.addMessage({ room: 'r2', seq: '2-0', content: 'y', ts: 2 });
  assert.equal(store.unreadFor('r2'), 2);
  assert.equal(store.unreadFor('r1'), 0);
  store.setCurrentRoom('r2');
  assert.equal(store.unreadFor('r2'), 0);
  assert.equal(store.messageCountFor('r1'), 0, '别的房间的消息不会进当前房间的消息流');
});

test('presence：joins 去重、leaves 移除、成员按名字排序', () => {
  const { store } = freshStore();
  store.setMembers('r1', [{ id: 'u2', name: 'Bob' }]);
  store.applyPresence('r1', [{ id: 'u2', name: 'Bob' }, { id: 'u1', name: 'Alice' }], []);
  assert.deepEqual(plain(store.membersFor('r1').map((m) => m.name)), ['Alice', 'Bob']);
  store.applyPresence('r1', [], ['u2']);
  assert.deepEqual(plain(store.membersFor('r1').map((m) => m.id)), ['u1']);
});

test('在线人数：presence 变化同步到房间列表，且不被 REST 快照覆盖回去', () => {
  const { store } = freshStore();
  store.setRooms([
    { id: 'r1', name: '大客厅', member_count: 0 },
    { id: 'r2', name: '技术交流', member_count: 5 },
  ]);
  store.setCurrentRoom('r1');

  store.setMembers('r1', [{ id: 'me', name: '我' }]); // joined 快照
  assert.equal(store.roomById('r1').member_count, 1, 'joined 后左栏人数要更新');

  store.applyPresence('r1', [{ id: 'u2', name: 'Bob' }], []);
  assert.equal(store.roomById('r1').member_count, 2, '有人进来，左栏人数要实时 +1');
  store.applyPresence('r1', [], ['u2']);
  assert.equal(store.roomById('r1').member_count, 1, '有人离开要 -1');

  // 重新拉 REST 列表：有实时成员列表的房间不能被旧快照覆盖
  store.setRooms([{ id: 'r1', name: '大客厅', member_count: 0 }]);
  assert.equal(store.roomById('r1').member_count, 1, '实时值优先于 REST 快照');

  // 没有实时数据的房间（不是当前房间）就用 REST 的值
  store.setRooms([{ id: 'r2', name: '技术交流', member_count: 7 }]);
  assert.equal(store.roomById('r2').member_count, 7);
});

test('typing：自己的 typing 不显示，别人的会显示', () => {
  const { store } = freshStore();
  store.setTyping('r1', { id: 'me', name: '我' });
  assert.equal(store.typingLabel('r1'), '');
  store.setTyping('r1', { id: 'u9', name: 'Alice' });
  assert.equal(store.typingLabel('r1'), 'Alice 正在输入…');
  store.clearTyping('r1');
  assert.equal(store.typingLabel('r1'), '');
});

test('登录态持久化：restoreSession 能读回，clearSession 能清掉', () => {
  const env = createEnv();
  const CR = env.load('js/config.js', 'js/store.js');
  CR.store.setSession('tok-1', { id: 'u1', name: 'Alice' });
  CR.store.clearSession();

  const env2 = createEnv({ storage: env.sandbox.localStorage });
  const CR2 = env2.load('js/config.js', 'js/store.js');
  const restored = CR2.store.restoreSession();
  assert.equal(restored, null, '退出登录后不应该再恢复出会话');

  CR2.store.setSession('tok-2', { id: 'u2', name: 'Bob' });
  const env3 = createEnv({ storage: env2.sandbox.localStorage });
  const CR3 = env3.load('js/config.js', 'js/store.js');
  assert.deepEqual(plain(CR3.store.restoreSession()), { token: 'tok-2', user: { id: 'u2', name: 'Bob' } });
});

test('配置默认值符合 guide 8.2（1s 起步、30s 封顶、±20% 抖动）', () => {
  const { CR } = freshEnv();
  assert.equal(CR.config.API_BASE, 'http://localhost:8080');
  assert.equal(CR.config.WS_BASE, 'ws://localhost:8080');
  assert.equal(CR.config.WS_RECONNECT_BASE, 1000);
  assert.equal(CR.config.WS_RECONNECT_MAX, 30000);
  assert.equal(CR.config.WS_JITTER, 0.2);
  assert.equal(CR.config.ACK_TIMEOUT, 10000);
  assert.equal(CR.config.TYPING_THROTTLE, 2000);
});

test('双击打开（file://）时自动启用 mock，静态服务器默认连真实后端', () => {
  const fileEnv = createEnv({ location: { search: '', protocol: 'file:', href: 'file:///web/index.html' } });
  const CRf = fileEnv.load('js/config.js');
  assert.equal(CRf.config.MOCK, true);

  const httpEnv = createEnv({ location: { search: '', protocol: 'http:', href: 'http://localhost:5173/' } });
  const CRh = httpEnv.load('js/config.js');
  assert.equal(CRh.config.MOCK, false);

  const forced = createEnv({ location: { search: '?mock=1', protocol: 'http:', href: 'http://x/' } });
  assert.equal(forced.load('js/config.js').config.MOCK, true);

  const off = createEnv({ location: { search: '?mock=0', protocol: 'file:', href: 'file:///x' } });
  assert.equal(off.load('js/config.js').config.MOCK, false);
});
test('运行时可改 API_BASE / WS_BASE（部署或联调时不用改文件）', () => {
  const { CR } = freshEnv();
  assert.equal(CR.config.apiURL('/rooms'), 'http://localhost:8080/rooms');
  assert.equal(CR.config.wsURL('/api/v1/ws'), 'ws://localhost:8080/api/v1/ws');

  CR.config.API_BASE = 'https://chat.example.com/';
  CR.config.WS_BASE = 'wss://chat.example.com/';
  assert.equal(CR.config.apiURL('/rooms'), 'https://chat.example.com/rooms', '尾部斜杠要归一');
  assert.equal(CR.config.wsURL('/api/v1/ws'), 'wss://chat.example.com/api/v1/ws');
});
