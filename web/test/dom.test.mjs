/*!
 * test/dom.test.mjs —— 把真正的 UI 层（components/* + main.js）在假 DOM 上跑一遍
 *
 * 这一层是"验收第 1 条（启动无报错）"里唯一能自动化的部分：
 * 用 test/dom.mjs 的 DOM 垫片解析真实的 index.html，按真实顺序加载全部脚本，
 * 然后像用户那样操作：登录 → 看渲染 → 发消息 → 切房间 → 看未读角标。
 * 任何一个渲染函数抛异常、id 写错、事件没绑上，这里都会红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, indexPath, FakeElement } from './dom.mjs';
import { createEnv, createSharedBus, createStorage, waitFor, plain, sleep } from './harness.mjs';

const SCRIPTS = [
  'js/config.js',
  'js/store.js',
  'js/mock.js',
  'js/api.js',
  'js/ws.js',
  'js/components/toast.js',
  'js/components/roomList.js',
  'js/components/messageList.js',
  'js/components/memberList.js',
  'js/main.js',
];

function bootUI(opts = {}) {
  const doc = createDocument(indexPath());
  const env = createEnv({
    location: { search: opts.search === undefined ? '?mock=1' : opts.search, protocol: 'http:', href: 'http://localhost:5173/' },
    storage: opts.storage || createStorage(),
  });
  const errors = [];
  const logs = [];
  env.sandbox.document = doc;
  env.sandbox.console = {
    log: (...a) => logs.push(a.join(' ')),
    warn: (...a) => logs.push('WARN ' + a.join(' ')),
    error: (...a) => errors.push(a.join(' ')),
  };
  // boot() 里有 setInterval(sweepTimeouts)，测试结束要清掉，不然进程不退出
  const intervals = [];
  env.sandbox.setInterval = (fn, ms) => {
    const h = setInterval(fn, ms);
    intervals.push(h);
    return h;
  };
  env.sandbox.clearInterval = (h) => clearInterval(h);

  env.load(...SCRIPTS);
  const CR = env.CR;
  if (opts.busEndpoint) CR.mock.useBus(opts.busEndpoint);
  CR.config.MOCK_LATENCY_MIN = 1;
  CR.config.MOCK_LATENCY_MAX = 4;
  CR.config.MOCK_AUTO_DEMO = false;
  CR.mock.setAutoDemo(false);

  return {
    env,
    CR,
    doc,
    errors,
    logs,
    cleanup() {
      intervals.forEach(clearInterval);
      if (CR.ws) CR.ws.close();
    },
    id: (x) => doc.getElementById(x),
    bubbles: () => doc.getElementById('message-list').querySelectorAll('.bubble'),
    rooms: () => doc.getElementById('room-list').querySelectorAll('.room-item'),
  };
}

/** 进入"可以正常收发"的稳态：选中房间 → 连接建立 → join 完成。 */
async function enterRoom(ui, roomId) {
  await waitFor(() => ui.CR.store.state.currentRoom === roomId, 4000, '选中房间 ' + roomId);
  await waitFor(() => ui.CR.ws.isOpen(), 4000, '连接建立');
  await waitFor(() => ui.CR.store.membersFor(roomId).length > 0, 4000, 'join 完成（拿到 joined）');
}

const PASSWORDS = { alice: 'alice123', bob: 'bob12345', bot: 'bot12345' };

async function login(ui, username) {
  // 用 mock 预置账号登录，避免走到注册分支
  ui.id('login-username').value = username;
  ui.id('login-password').value = PASSWORDS[username] || 'alice123';
  ui.id('login-form').dispatchEvent('submit');
  await waitFor(
    () => ui.id('view-chat').hidden === false,
    4000,
    '进入聊天视图（登录失败信息：' + ui.id('login-error').textContent + '）'
  );
}

test('加载全部脚本即完成启动：登录视图可见、无 console.error', async () => {
  const ui = bootUI();
  try {
    assert.deepEqual(plain(ui.errors), [], '启动阶段不该有 console.error');
    assert.equal(ui.id('view-login').hidden, false, '应该显示登录视图');
    assert.equal(ui.id('view-chat').hidden, true, '聊天视图初始应隐藏');
    assert.match(ui.id('mode-hint').textContent, /mock/, 'mock 模式下应提示当前是 mock');
    assert.ok(ui.doc.title.includes('chatroom'), '标题应设置好');
    // 非 mock 模式下 mock 工具应该藏起来
    const mockOnly = ui.doc.querySelectorAll('.mock-only');
    assert.equal(mockOnly.length, 2, 'index.html 里应有两个演示按钮');
    mockOnly.forEach((n) => assert.equal(n.hidden, false, 'mock 模式下演示按钮要可见'));
  } finally {
    ui.cleanup();
  }
});

test('登录 → 渲染房间/历史/成员：真实 DOM 节点都出来了', async () => {
  const ui = bootUI();
  try {
    await login(ui, 'alice');
    await enterRoom(ui, 'r1');

    await waitFor(() => ui.rooms().length >= 2, 4000, '房间列表渲染');
    assert.equal(ui.id('me-name').textContent, 'Alice', '顶栏显示当前用户');
    assert.equal(ui.id('room-name').textContent, '大客厅', '自动选中第一个房间');

    // mock 的 r1 预置 90 条，REST 一页 50 条 + sync 补 60 条 → 至少 50 个气泡
    await waitFor(() => ui.bubbles().length >= 50, 4000, '历史消息渲染（含分页前的第一页）');
    await waitFor(() => ui.rooms()[0].classList.contains('active'), 4000, '当前房间高亮');

    // 成员列表（mock 的 r1 预置了 bot + alice，再加上自己）
    await waitFor(() => ui.id('member-list').querySelectorAll('.member-item').length >= 1, 4000, '成员列表渲染');
    assert.ok(ui.id('member-count').textContent !== '', '成员数角标要有值');

    // 自己发的消息靠右、他人靠左
    const own = ui.id('message-list').querySelectorAll('.msg-own');
    const other = ui.id('message-list').querySelectorAll('.msg-other');
    assert.ok(other.length > 0, '预置历史来自别人，应该是 msg-other（靠左）');
    void own;
    assert.deepEqual(plain(ui.errors), [], '渲染阶段不该有 console.error');
  } finally {
    ui.cleanup();
  }
});

test('发消息：乐观上屏 → ack 后原地变已发送，不重复渲染', async () => {
  const ui = bootUI();
  try {
    await login(ui, 'alice');
    await enterRoom(ui, 'r1');
    await waitFor(() => ui.bubbles().length > 0, 4000, '历史先渲染出来');

    const before = ui.bubbles().length;
    const input = ui.id('input-message');
    input.value = 'DOM 测试消息';
    input.dispatchEvent('keydown', { key: 'Enter', shiftKey: false });

    // 同步阶段应该先出现"发送中"的乐观消息（mock 的 ack 是异步的）
    const pending = ui.id('message-list').querySelectorAll('.msg-pending');
    assert.equal(pending.length, 1, '应该立刻乐观上屏一条');
    assert.match(pending[0].textContent, /发送中/, '乐观消息应先显示"发送中"');
    assert.equal(input.value, '', '发送后输入框应清空');

    await waitFor(() => ui.id('message-list').querySelectorAll('.msg-pending').length === 0, 4000, 'ack 后占位被替换');
    const after = ui.bubbles();
    assert.equal(after.length, before + 1, '只能多一条（乐观占位不能和真实消息重复渲染）');
    assert.equal(after[after.length - 1].textContent, 'DOM 测试消息');
  } finally {
    ui.cleanup();
  }
});

test('没连接时发送：标记"发送失败，点击重试"，重连后点它能成功且只有一条', async () => {
  const ui = bootUI();
  try {
    await login(ui, 'alice');
    await enterRoom(ui, 'r1');
    ui.CR.ws.close(); // 主动断开：模拟"正在重连"时用户仍然按了发送

    const input = ui.id('input-message');
    input.value = '断线期间发的';
    input.dispatchEvent('keydown', { key: 'Enter', shiftKey: false });

    const failed = ui.id('message-list').querySelectorAll('.msg-failed');
    assert.equal(failed.length, 1, '没连上时应该标记失败');
    const retryBtn = failed[0].querySelectorAll('.msg-retry')[0];
    assert.ok(retryBtn, '失败消息要给出可点的重试按钮');
    assert.match(retryBtn.textContent, /发送失败，点击重试/);

    // 恢复连接，再点重试
    ui.CR.ws.connect(ui.CR.api.getToken());
    await waitFor(() => ui.CR.ws.isOpen(), 4000, '重连回来');
    retryBtn.dispatchEvent('click');

    await waitFor(() => ui.id('message-list').querySelectorAll('.msg-pending').length === 0, 4000, '重试后发送成功');
    const texts = ui.bubbles().map((b) => b.textContent);
    assert.equal(
      texts.filter((t) => t === '断线期间发的').length,
      1,
      '重试必须复用同一个 client_msg_id，只能出现一条'
    );
  } finally {
    ui.cleanup();
  }
});

test('切换房间：标题、消息流、未读角标都跟着走', async () => {
  const ui = bootUI();
  try {
    await login(ui, 'alice');
    await enterRoom(ui, 'r1');
    await waitFor(() => ui.rooms().length >= 2, 4000, '房间列表渲染');

    // 让别的房间来一条消息 → 角标 +1
    ui.CR.mock.demoOtherRoomMessage('r1');
    await waitFor(() => ui.id('room-list').querySelectorAll('.badge').length === 1, 4000, '未读角标出现');
    const badge = ui.id('room-list').querySelectorAll('.badge')[0];
    assert.equal(badge.textContent, '1');

    // 点击第二个房间（通过子节点点击，验证事件委托 + closest）
    const target = ui.rooms()[1];
    const nameSpan = target.querySelectorAll('.room-item-name')[0];
    assert.ok(nameSpan instanceof FakeElement, '房间项里应该有名字节点');
    nameSpan.dispatchEvent('click');

    await waitFor(() => ui.id('room-name').textContent === '技术交流', 4000, '切到第二个房间');
    assert.equal(ui.id('room-list').querySelectorAll('.badge').length, 0, '切过去后未读要清零');
    // 新房间的消息流：WS 的演示消息 和 REST 拉来的历史谁先到不确定，都等一等
    await waitFor(() => ui.bubbles().length >= 1, 4000, '新房间的消息流渲染出来');
    await waitFor(
      () => ui.bubbles().some((b) => /Redis Stream/.test(b.textContent)),
      4000,
      'r2 的预置历史加载出来'
    );
    assert.ok(
      ui.bubbles().some((b) => /另一个房间/.test(b.textContent)),
      '刚演示的那条"别的房间"消息也应该出现在这里'
    );
  } finally {
    ui.cleanup();
  }
});

test('左栏人数与右栏在线成员实时一致（不用刷新页面）', async () => {
  const ui = bootUI();
  try {
    await login(ui, 'alice');
    await enterRoom(ui, 'r1');
    await waitFor(() => ui.rooms().length >= 2, 4000, '房间列表渲染');

    const roomItem = () => ui.rooms().find((r) => r.getAttribute('data-room') === 'r1');
    const rightCount = () => ui.id('member-list').querySelectorAll('.member-item').length;

    await waitFor(() => rightCount() >= 1, 4000, '右栏成员渲染');
    const n1 = rightCount();
    assert.ok(
      new RegExp(n1 + '\\s*人').test(roomItem().textContent),
      '左栏人数应等于右栏在线成员数：左栏=' + roomItem().textContent + ' 右栏=' + n1
    );

    // 有人进来 / 离开 → 两边都要立刻变，且不许再发 REST 请求去"刷新"
    let listRoomsCalls = 0;
    const rawListRooms = ui.CR.api.listRooms;
    ui.CR.api.listRooms = function () {
      listRoomsCalls++;
      return rawListRooms.apply(this, arguments);
    };

    ui.CR.store.applyPresence('r1', [{ id: 'u_new', name: 'Newcomer' }], []);
    await waitFor(() => /Newcomer/.test(ui.id('member-list').textContent), 4000, '右栏出现新成员');
    const n2 = rightCount();
    assert.equal(n2, n1 + 1);
    assert.ok(
      new RegExp(n2 + '\\s*人').test(roomItem().textContent),
      '左栏人数要跟着变成 ' + n2 + '，实际：' + roomItem().textContent
    );

    ui.CR.store.applyPresence('r1', [], ['u_new']);
    await waitFor(
      () => new RegExp(n1 + '\\s*人').test(roomItem().textContent),
      4000,
      '成员离开后左栏人数变回 ' + n1
    );
    assert.equal(listRoomsCalls, 0, '当前房间的人数是 presence 驱动的，不该靠重新请求 REST');
  } finally {
    ui.cleanup();
  }
});

test('断线横幅：offline 时显示"正在重连（第 n 次）"', async () => {
  const ui = bootUI();
  try {
    await login(ui, 'alice');
    await enterRoom(ui, 'r1');
    assert.equal(ui.id('conn-banner').hidden, true, '正常时不该有横幅');

    ui.CR.mock.simulateDrop();
    await waitFor(() => ui.id('conn-banner').hidden === false, 4000, '出现断线横幅');
    assert.match(ui.id('conn-banner').textContent, /连接已断开，正在重连（第 \d+ 次）/, '横幅文案要符合验收要求');

    await waitFor(() => ui.id('conn-banner').hidden === true, 6000, '重连成功后横幅收起');
  } finally {
    ui.cleanup();
  }
});

test('mock 工具按钮：模拟断线 / 其它房间来消息都能用', async () => {
  const ui = bootUI();
  try {
    await login(ui, 'alice');
    await enterRoom(ui, 'r1');

    ui.id('btn-demo-other').dispatchEvent('click');
    await waitFor(() => ui.CR.store.unreadFor('r2') === 1, 4000, '别的房间来消息 → 未读 +1');

    ui.id('btn-simulate-drop').dispatchEvent('click');
    await waitFor(() => ui.CR.ws.status().status === 'offline', 4000, '模拟断线生效');
    await waitFor(() => ui.CR.ws.status().status === 'online', 8000, '自动重连回来');

    // toast 应该渲染到 #toast-host
    assert.ok(ui.id('toast-host').childNodes.length >= 1, 'toast 应该出现在 toast-host 里');
    assert.deepEqual(plain(ui.errors), [], '整个过程不该有 console.error');
  } finally {
    ui.cleanup();
  }
});

test('两个窗口：一个窗口关掉时，另一个窗口的成员名单与人数立刻少一个', async () => {
  const storage = createStorage();
  const hub = createSharedBus();
  const a = bootUI({ storage, busEndpoint: hub.createEndpoint() });
  const b = bootUI({ storage, busEndpoint: hub.createEndpoint() });
  try {
    await login(a, 'alice');
    await enterRoom(a, 'r1');
    await login(b, 'bob');
    await enterRoom(b, 'r1');

    const bobId = b.CR.store.state.session.user.id;
    await waitFor(() => a.CR.store.membersFor('r1').some((m) => m.id === bobId), 4000, 'A 看到 B 在线');
    const before = a.CR.store.membersFor('r1').length;

    // 关掉 B 那个窗口：mock 会在 beforeunload 抢着广播一次 leave
    b.env.sandbox.dispatchEvent('beforeunload');

    await waitFor(() => !a.CR.store.membersFor('r1').some((m) => m.id === bobId), 3000, 'B 从 A 的名单里消失');
    assert.equal(a.CR.store.membersFor('r1').length, before - 1);
    assert.equal(a.CR.store.roomById('r1').member_count, before - 1, '左栏人数也要跟着掉');
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test('切回标签页刷新房间列表：hidden 不请求，visible 才请求一次', async () => {
  const ui = bootUI();
  try {
    await login(ui, 'alice');
    await enterRoom(ui, 'r1');

    let calls = 0;
    const raw = ui.CR.api.listRooms;
    ui.CR.api.listRooms = function () {
      calls++;
      return raw.apply(this, arguments);
    };

    ui.doc.visibilityState = 'hidden';
    ui.doc.dispatchEvent('visibilitychange');
    await sleep(60);
    assert.equal(calls, 0, '页面在后台时不该发请求');

    ui.doc.visibilityState = 'visible';
    ui.doc.dispatchEvent('visibilitychange');
    await waitFor(() => calls >= 1, 2000, '切回前台刷新一次房间列表');
    assert.equal(calls, 1, '一次只刷一次，不能变成轮询');
  } finally {
    ui.cleanup();
  }
});

test('退出登录：回到登录视图并清掉本地会话', async () => {
  const storage = createStorage();
  const ui = bootUI({ storage });
  try {
    await login(ui, 'alice');
    await waitFor(() => ui.rooms().length >= 2, 4000, '房间列表渲染');
    assert.ok(ui.CR.store.state.session.token, '登录后应有 token');

    ui.id('btn-logout').dispatchEvent('click');
    assert.equal(ui.id('view-login').hidden, false, '应该回到登录视图');
    assert.equal(ui.id('view-chat').hidden, true);
    assert.equal(ui.CR.store.state.session.token, '', 'store 里的会话要清掉');
    assert.equal(storage.getItem('cr.session'), null, 'localStorage 里的会话也要清掉');
  } finally {
    ui.cleanup();
  }
});