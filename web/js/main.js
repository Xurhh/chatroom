/*!
 * js/main.js —— 入口：视图切换、事件绑定、把 store / api / ws / 组件接起来
 *
 * 数据流（单向）：
 *   用户操作 → CR.api（REST） / CR.ws（上行帧） → 服务端
 *   服务端下行 → CR.ws 事件 → CR.store 改状态 → subscribe → 组件重渲染
 */
(function (global) {
  'use strict';

  const CR = (global.CR = global.CR || {});
  const doc = () => global.document;

  let authMode = 'login'; // login | register
  let joinedRoom = ''; // 已经向服务端 join 过的房间（重连后需要重新 join）
  let typingThrottled = null;
  // "刚进房间、join 还没完成就按了发送"的消息：先留在队列里，等 joined 到了自动补发
  // （服务端返回 4002 "join a room first"）。复用同一个 client_msg_id，所以不会重复。
  let awaitingJoin = [];

  function el(id) {
    return doc().getElementById(id);
  }

  function show(view) {
    const isChat = view === 'chat';
    const loginView = el('view-login');
    const chatView = el('view-chat');
    if (loginView) loginView.hidden = isChat;
    if (chatView) chatView.hidden = !isChat;
    doc().body.classList.toggle('in-chat', isChat);
  }

  // ------------------------------------------------------------ 渲染调度

  function renderTopbar(state) {
    const room = state.currentRoom ? CR.store.roomById(state.currentRoom) : null;
    const nameNode = el('room-name');
    const meNode = el('me-name');
    if (nameNode) nameNode.textContent = room ? room.name || room.id : '未选择房间';
    if (meNode) meNode.textContent = state.session.user ? state.session.user.name : '';
    const total = CR.store.totalUnread();
    doc().title = (total > 0 ? '(' + total + ') ' : '') + 'chatroom';
  }

  function renderAll(state) {
    CR.components.roomList.render(state);
    CR.components.messageList.render(state);
    CR.components.memberList.render(state);
    CR.components.toast.render(state);
    renderTopbar(state);
  }

  // -------------------------------------------------------------- 认证

  function setAuthMode(mode) {
    authMode = mode;
    const isRegister = mode === 'register';
    const submit = el('login-submit');
    const toggle = el('login-toggle');
    const hint = el('login-hint');
    if (submit) submit.textContent = isRegister ? '注册并登录' : '登录';
    if (toggle) toggle.textContent = isRegister ? '已有账号？去登录' : '没有账号？去注册';
    if (hint) {
      hint.textContent = isRegister
        ? '用户名 + 至少 6 位密码；注册成功后会自动登录。'
        : '没有账号？点下面切换成注册。';
    }
    const err = el('login-error');
    if (err) err.hidden = true;
  }

  function showLoginError(text) {
    const err = el('login-error');
    if (!err) return;
    err.hidden = false;
    err.textContent = text;
  }

  function flushAwaitingJoin(room) {
    const rest = [];
    awaitingJoin.forEach((item) => {
      if (item.room !== room) {
        rest.push(item);
        return;
      }
      if (!CR.ws.chat(item.room, item.cmid, item.content)) {
        rest.push(item);
        CR.store.markFailed(item.cmid);
      }
    });
    awaitingJoin = rest;
  }

  function handleUnauthorized() {
    // token 失效：清登录态、断开、回登录视图，并且不再重连（ws.close 会置 manualClose）
    const wasLoggedIn = !!CR.store.state.session.token || CR.store.state.view === 'chat';
    awaitingJoin = [];
    CR.ws.close();
    CR.api.setToken('');
    CR.store.clearSession();
    joinedRoom = '';
    CR.components.messageList.reset();
    show('login');
    if (wasLoggedIn) CR.store.toast('登录已失效，请重新登录', 'error');
  }

  async function submitAuth(ev) {
    if (ev) ev.preventDefault();
    const username = ((el('login-username') || {}).value || '').trim();
    const password = (el('login-password') || {}).value || '';
    if (!username || !password) {
      showLoginError('用户名和密码都要填');
      return;
    }
    const submit = el('login-submit');
    if (submit) submit.disabled = true;
    try {
      if (authMode === 'register') {
        await CR.api.register(username, password);
      }
      const res = await CR.api.login(username, password);
      if (!res || !res.token) throw new Error('服务端没有返回 token');
      CR.api.setToken(res.token);
      CR.store.setSession(res.token, res.user || { id: '', name: username });
      show('chat');
      CR.ws.connect(res.token);
      await loadRooms(true);
    } catch (e) {
      const msg = e && e.message ? e.message : '登录失败';
      showLoginError(msg);
      CR.store.toast(msg, 'error');
    } finally {
      if (submit) submit.disabled = false;
      const pw = el('login-password');
      if (pw) pw.value = '';
    }
  }

  function logout() {
    awaitingJoin = [];
    CR.ws.close();
    CR.api.setToken('');
    CR.store.clearSession();
    joinedRoom = '';
    CR.components.messageList.reset();
    show('login');
    setAuthMode('login');
  }

  // -------------------------------------------------------------- 房间

  async function loadRooms(autoSelect) {
    try {
      const res = await CR.api.listRooms({ limit: 50 });
      const rooms = (res && res.rooms) || [];
      CR.store.setRooms(rooms, (res && res.next_cursor) || '');
      if (!rooms.length) {
        CR.store.toast('还没有房间，可以在左侧新建一个', 'info');
        return;
      }
      const state = CR.store.state;
      if (!state.currentRoom || !rooms.some((r) => r.id === state.currentRoom)) {
        if (autoSelect !== false) {
          const preferred = rooms.find((r) => r.id === 'lobby') || rooms[0];
          selectRoom(preferred.id);
        }
      }
    } catch (e) {
      CR.store.toast(e.message || '获取房间列表失败', 'error');
    }
  }

  async function selectRoom(roomId) {
    if (!roomId) return;
    const state = CR.store.state;
    if (state.currentRoom && state.currentRoom !== roomId) {
      CR.ws.leave(state.currentRoom); // 服务端会把我移出旧房间（presence 也会更新）
      joinedRoom = '';
    }
    CR.store.setCurrentRoom(roomId);
    CR.components.messageList.reset();
    doc().body.classList.remove('show-rooms'); // 移动端抽屉自动收起

    // 先加载历史再 join：这样 WS 的 sync 补拉结果会并进已加载的历史里（store 是并集语义）
    await loadHistory(roomId);
    joinCurrentRoom();
    if (CR.store.roomById(roomId)) {
      // 成员列表先用 REST 兜底，WS 的 joined / presence 会覆盖它
      CR.api
        .roomMembers(roomId)
        .then((res) => CR.store.setMembers(roomId, (res && res.members) || []))
        .catch(() => {});
    }
  }

  function joinCurrentRoom() {
    const state = CR.store.state;
    const room = state.currentRoom;
    if (!room) return;
    const ok = CR.ws.join(room, CR.store.lastSeqFor(room));
    if (ok) joinedRoom = room;
  }

  async function loadHistory(roomId) {
    CR.store.setLoadingMore(roomId, true);
    try {
      const res = await CR.api.roomMessages(roomId, { limit: CR.config.PAGE_SIZE });
      // 后端返回倒序（新→旧），反转成升序再入库
      const asc = ((res && res.messages) || []).slice().reverse();
      CR.store.setHistory(roomId, asc, !!(res && res.has_more));
      CR.components.messageList.scrollToBottom();
    } catch (e) {
      CR.store.toast(e.message || '加载历史消息失败', 'error');
    } finally {
      CR.store.setLoadingMore(roomId, false);
    }
  }

  async function loadMore(roomId, beforeSeq) {
    if (!roomId || !beforeSeq) return;
    const state = CR.store.state;
    if (state.loadingMore[roomId]) return;
    CR.store.setLoadingMore(roomId, true);
    try {
      const res = await CR.api.roomMessages(roomId, {
        beforeSeq,
        limit: CR.config.PAGE_SIZE,
      });
      const asc = ((res && res.messages) || []).slice().reverse();
      CR.store.prependHistory(roomId, asc, !!(res && res.has_more));
    } catch (e) {
      CR.store.toast(e.message || '加载更早的消息失败', 'error');
    } finally {
      CR.store.setLoadingMore(roomId, false);
    }
  }

  async function createRoom() {
    const input = el('new-room-name');
    const name = ((input && input.value) || '').trim();
    if (!name) return;
    try {
      const room = await CR.api.createRoom(name);
      CR.store.upsertRoom(room);
      if (input) input.value = '';
      const form = el('new-room-form');
      if (form) form.hidden = true;
      await loadRooms(false);
      selectRoom(room.id);
    } catch (e) {
      CR.store.toast(e.message || '创建房间失败', 'error');
    }
  }

  // -------------------------------------------------------------- 发送

  function sendMessage() {
    const input = el('input-message');
    const state = CR.store.state;
    const room = state.currentRoom;
    const content = ((input && input.value) || '').trim();
    if (!content) return;
    if (!room) {
      CR.store.toast('先选择一个房间', 'error');
      return;
    }
    const clientMsgId = CR.util.uuid();
    CR.store.addPending(room, clientMsgId, content, state.session.user);
    const ok = CR.ws.chat(room, clientMsgId, content);
    if (!ok) {
      CR.store.markFailed(clientMsgId);
      CR.store.toast('连接未就绪，消息已标记为失败，可点击重试', 'error');
    }
    if (input) {
      input.value = '';
      autoResize(input);
    }
  }

  function retry(clientMsgId) {
    const item = CR.store.retryPending(clientMsgId);
    if (!item) return;
    const ok = CR.ws.chat(item.roomId, item.clientMsgId, item.content);
    if (!ok) {
      CR.store.markFailed(item.clientMsgId);
      CR.store.toast('仍未连接，稍后再试', 'error');
    }
  }

  function autoResize(node) {
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = Math.min(160, node.scrollHeight) + 'px';
  }

  // ----------------------------------------------------------- WS 事件

  function wireWS() {
    // token 有效性探针：让 ws.js 能区分"token 失效（HTTP 401）"和"网络不通"
    CR.ws.setAuthProbe(() =>
      CR.api
        .me()
        .then(() => true)
        .catch((e) => (e && e.status === 401 ? false : Promise.reject(e)))
    );

    CR.ws.on('status', (st) => {
      CR.store.setConn(st.status, st.retry || 0);
    });

    CR.ws.on('open', () => {
      CR.store.setConn('online', 0);
      if (joinedRoom && CR.store.state.currentRoom) {
        CR.store.toast('已重新连接，正在补齐消息…', 'success');
      }
      // 重连成功的收尾工作：带 last_seq 重新 join（服务端用 sync 补拉漏收的）
      joinCurrentRoom();
      // 顺手刷一遍房间列表：别的房间有没有人进出，只有 REST 能看到（presence 只推本房间）
      loadRooms(false);
    });

    CR.ws.on('unauthorized', () => handleUnauthorized());

    CR.ws.on('joined', (frame) => {
      if (!frame.room) return;
      CR.store.setMembers(frame.room, frame.members || []);
      if (frame.room === CR.store.state.currentRoom) {
        CR.store.clearUnread(frame.room);
      }
      flushAwaitingJoin(frame.room);
    });

    CR.ws.on('sync', (frame) => {
      if (!frame.room) return;
      const added = CR.store.applySync(frame.room, frame.messages || [], frame.last_seq || '');
      if (added > 0 && frame.room === CR.store.state.currentRoom) {
        CR.components.messageList.scrollToBottom();
      }
    });

    CR.ws.on('message', (frame) => {
      const result = CR.store.addMessage(frame);
      if (result === 'added' && frame.room === CR.store.state.currentRoom) {
        CR.components.messageList.scrollToBottom();
      }
    });

    CR.ws.on('ack', (frame) => {
      CR.store.applyAck(frame.client_msg_id, frame.seq);
    });

    CR.ws.on('presence', (frame) => {
      if (!frame.room) return;
      CR.store.applyPresence(frame.room, frame.joins || [], frame.leaves || []);
      const me = CR.store.state.session.user ? CR.store.state.session.user.id : '';
      if (frame.room === CR.store.state.currentRoom) {
        (frame.joins || []).forEach((u) => {
          if (u && u.id !== me) CR.store.addNotice(frame.room, (u.name || u.id) + ' 加入了房间');
        });
        (frame.leaves || []).forEach((id) => {
          if (id !== me) CR.store.addNotice(frame.room, (id || '有人') + ' 离开了房间');
        });
      }
    });

    CR.ws.on('typing', (frame) => {
      if (!frame.room || frame.room !== CR.store.state.currentRoom) return;
      CR.store.setTyping(frame.room, frame.from);
      const room = frame.room;
      setTimeout(() => {
        const t = CR.store.state.typing[room];
        if (t && Date.now() - t.at >= CR.config.TYPING_HIDE - 50) CR.store.clearTyping(room);
      }, CR.config.TYPING_HIDE);
    });

    CR.ws.on('error', (frame) => {
      if (!frame || frame.type !== 'error') return;
      if (frame.code === 4002 && frame.ref) {
        // "join 还没完成就发言"：不是真的失败，改回"发送中"并排队，等 joined 后自动补发
        const item = CR.store.retryPending(frame.ref);
        if (item) {
          awaitingJoin.push({ cmid: item.clientMsgId, room: item.roomId, content: item.content });
          return;
        }
      }
      CR.store.toast(frame.message || '服务端返回错误', 'error');
      if (frame.ref) CR.store.markFailed(frame.ref);
    });
  }

  // ------------------------------------------------------------- 启动

  function wireUI() {
    // 登录表单
    const form = el('login-form');
    if (form) form.addEventListener('submit', submitAuth);
    const toggle = el('login-toggle');
    if (toggle) {
      toggle.addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));
    }
    const logoutBtn = el('btn-logout');
    if (logoutBtn) logoutBtn.addEventListener('click', logout);

    // 房间
    CR.components.roomList.onSelect((roomId) => selectRoom(roomId));
    const newRoomBtn = el('btn-new-room');
    if (newRoomBtn) {
      newRoomBtn.addEventListener('click', () => {
        const box = el('new-room-form');
        if (box) {
          box.hidden = !box.hidden;
          if (!box.hidden) {
            const input = el('new-room-name');
            if (input) input.focus();
          }
        }
      });
    }
    const createBtn = el('btn-create-room');
    if (createBtn) createBtn.addEventListener('click', createRoom);
    const newRoomInput = el('new-room-name');
    if (newRoomInput) {
      newRoomInput.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          createRoom();
        }
      });
    }

    // 消息流
    CR.components.messageList.onLoadMore((roomId, beforeSeq) => loadMore(roomId, beforeSeq));
    CR.components.messageList.onRetry((cmid) => retry(cmid));

    // 输入框：Enter 发送 / Shift+Enter 换行
    const input = el('input-message');
    if (input) {
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          sendMessage();
        }
      });
      input.addEventListener('input', () => {
        autoResize(input);
        if (typingThrottled && input.value.trim()) typingThrottled();
      });
    }
    const composer = el('composer');
    if (composer) {
      composer.addEventListener('submit', (ev) => {
        ev.preventDefault();
        sendMessage();
      });
    }

    // 移动端抽屉
    const toggleRooms = el('btn-toggle-rooms');
    if (toggleRooms) {
      toggleRooms.addEventListener('click', () => {
        doc().body.classList.toggle('show-rooms');
        doc().body.classList.remove('show-members');
      });
    }
    const toggleMembers = el('btn-toggle-members');
    if (toggleMembers) {
      toggleMembers.addEventListener('click', () => {
        doc().body.classList.toggle('show-members');
        doc().body.classList.remove('show-rooms');
      });
    }
    doc().addEventListener('click', (ev) => {
      if (ev.target === doc().body) {
        doc().body.classList.remove('show-rooms', 'show-members');
      }
    });

    // 切回这个标签页时刷新一次房间列表（长时间挂在后台，别的房间人数早就不准了）。
    // 当前房间的人数有 presence 兜底，不依赖这次刷新。
    doc().addEventListener('visibilitychange', () => {
      if (doc().visibilityState === 'hidden') return;
      if (CR.store.state.view !== 'chat' || !CR.store.state.session.token) return;
      loadRooms(false);
    });

    // mock 专属工具
    const mockOnly = doc().querySelectorAll('.mock-only');
    Array.prototype.forEach.call(mockOnly, (node) => {
      node.hidden = !CR.config.MOCK;
    });
    const dropBtn = el('btn-simulate-drop');
    if (dropBtn) {
      dropBtn.addEventListener('click', () => {
        const n = CR.mock.simulateDrop();
        CR.store.toast('已模拟断线（' + n + ' 条连接），观察自动重连与补拉', 'info');
      });
    }
    const otherBtn = el('btn-demo-other');
    if (otherBtn) {
      otherBtn.addEventListener('click', () => {
        CR.mock.demoOtherRoomMessage(CR.store.state.currentRoom);
      });
    }

    // 模式提示
    const modeHint = el('mode-hint');
    if (modeHint) {
      modeHint.textContent = CR.config.MOCK
        ? '当前是 mock 模式（无需后端）：随便注册一个账号即可演示，双击/静态服务器都能跑。加 ?mock=0 可切到真实后端。'
        : '当前连真实后端：' + CR.config.API_BASE + '（跨域需要后端 ALLOWED_ORIGINS 包含本页地址）';
    }
  }

  function boot() {
    CR.store.subscribe(renderAll);
    CR.api.setOnUnauthorized(() => handleUnauthorized());
    CR.components.roomList.mount();
    CR.components.messageList.mount();
    wireUI();
    wireWS();

    typingThrottled = CR.util.throttle(() => {
      const room = CR.store.state.currentRoom;
      if (room) CR.ws.typing(room);
    }, CR.config.TYPING_THROTTLE);

    // ack 超时扫描（每 1s 一次；只改状态，不阻塞 UI）
    global.setInterval(() => CR.store.sweepTimeouts(), 1000);

    setAuthMode('login');
    const restored = CR.store.restoreSession();
    if (restored && restored.token) {
      CR.api.setToken(restored.token);
      show('chat');
      CR.ws.connect(restored.token);
      // 验证 token 是否还有效（失效会走 handleUnauthorized 回登录页）
      CR.api
        .me()
        .then((user) => {
          if (user && user.id) CR.store.setSession(restored.token, user);
          return loadRooms(true);
        })
        .catch((e) => {
          if (!e || e.status === 401) handleUnauthorized();
          else CR.store.toast(e.message || '无法连接服务器', 'error');
        });
    } else {
      show('login');
    }
    renderAll(CR.store.state);
  }

  if (doc().readyState === 'loading') {
    doc().addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  CR.main = { sendMessage, selectRoom, loadRooms, logout, handleUnauthorized };
})(typeof window !== 'undefined' ? window : globalThis);