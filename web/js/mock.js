/*!
 * js/mock.js —— 内置假后端（REST + 假 WS），MOCK 模式下无需任何后端即可完整演示
 *
 * 它模拟的是"真实后端语义"而不是"随便回点数据"：
 *   - REST 返回结构与 guide 5.3 一字不差（含 history 的倒序 + has_more）
 *   - 假 WS 走同一套 C→S / S→C envelope（join/leave/chat/typing → sync/joined/ack/message/presence）
 *   - 幂等：同一个 client_msg_id 重发只回原 seq 的 ack，不重复产生消息
 *   - 跨窗口：用 BroadcastChannel 把消息/presence 同步给另一个浏览器窗口（降级用 localStorage）
 *   - 演示用：机器人会发言、假用户会进出；另提供"模拟断线"按钮验证重连 + 补拉
 *
 * 约定：本文件不出现 fetch / new WebSocket（真正的网络只允许在 api.js / ws.js 里）。
 */
(function (global) {
  'use strict';

  const CR = (global.CR = global.CR || {});

  const DB_KEY = 'cr.mock.db.v2'; // 改动预置数据时把版本号 +1，避免旧 localStorage 盖住新种子
  const BUS_NAME = 'cr.mock.bus.v1';
  const MAX_HISTORY = 500; // 每个房间最多保留多少条（模拟 Stream 的 MAXLEN 裁剪）
  // join 时最多补拉多少条：真实后端是 chat.SyncLimit（默认 200），mock 调到 60，
  // 这样预置的 90 条历史里必然有一截 sync 补不到，只能靠 REST 向上翻页取 —— 翻页效果才演示得出来。
  const SYNC_LIMIT = 60;

  let db = null;
  let bus = null;
  let seqCounter = Math.floor(Math.random() * 90); // 避免两个窗口生成同一个 seq
  let autoDemo = true;
  let socketSeq = 0;

  const dedup = new Map(); // "roomId|clientMsgId" -> seq
  const sockets = new Set(); // 本窗口活着的假 socket
  const demoDone = new Set(); // 每个房间只做一次自动演示

  // ------------------------------------------------------------ 基础工具

  function latency() {
    const min = CR.config.MOCK_LATENCY_MIN;
    const max = CR.config.MOCK_LATENCY_MAX;
    return Math.round(min + Math.random() * Math.max(0, max - min));
  }

  function nowSec() {
    return Math.floor(Date.now() / 1000);
  }

  function newSeq() {
    seqCounter = (seqCounter + 1) % 100000;
    return Date.now() + '-' + seqCounter;
  }

  function roomId(n) {
    return 'r' + n;
  }

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function nextRoomNumber() {
    let max = 0;
    db.rooms.forEach((r) => {
      const n = parseInt(String(r.id).replace(/[^0-9]/g, ''), 10);
      if (Number.isFinite(n) && n > max) max = n;
    });
    return max + 1;
  }

  // --------------------------------------------------------- 预置数据/持久化

  function seed() {
    const t = nowSec();
    // r1 预置 90 条历史：用来演示"滚到顶部加载更早一页"。
    // 数量故意大于 SYNC_LIMIT(60)，所以 join 的 sync 只能补到最新 60 条，
    // 剩下 30 条必须靠 REST 的 before_seq 翻页取 —— 否则翻页逻辑永远走不到。
    const r1 = [];
    for (let i = 0; i < 88; i++) {
      r1.push({
        seq: 1699999999000 + i * 7 + '-0',
        from: { id: 'u_alice', name: 'Alice' },
        content: '历史消息 #' + (i + 1) + '：滚到最上面会自动加载更早的一页',
        ts: t - 8000 + i * 60,
      });
    }
    r1.push({
      seq: '1700000000001-0',
      from: { id: 'u_bot', name: '小助手' },
      content: '欢迎来到大客厅 👋 这是 mock 模式，不需要后端就能演示。',
      ts: t - 3600,
    });
    r1.push({
      seq: '1700000000002-0',
      from: { id: 'u_alice', name: 'Alice' },
      content: '试试发一条消息，再开一个窗口看双人互聊效果。',
      ts: t - 3000,
    });

    return {
      users: {
        alice: { id: 'u_alice', name: 'Alice', password: 'alice123' },
        bob: { id: 'u_bob', name: 'Bob', password: 'bob12345' },
        bot: { id: 'u_bot', name: '小助手', password: 'bot12345' },
      },
      rooms: [
        { id: roomId(1), name: '大客厅', member_count: 0 },
        { id: roomId(2), name: '技术交流', member_count: 0 },
      ],
      messages: {
        r1,
        r2: [
          {
            seq: '1700000000003-0',
            from: { id: 'u_bob', name: 'Bob' },
            content: 'Redis Stream 的 ID 天生就是单调递增的，所以能直接当 seq。',
            ts: t - 2000,
          },
        ],
      },
      members: {
        r1: { u_bot: '小助手', u_alice: 'Alice' },
        r2: { u_bob: 'Bob' },
      },
    };
  }

  function load() {
    let raw = null;
    try {
      raw = CR.storage.get(DB_KEY);
    } catch (e) {
      raw = null;
    }
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.rooms && parsed.messages) return parsed;
      } catch (e) {
        /* 坏了就重新种一份 */
      }
    }
    const fresh = seed();
    CR.storage.set(DB_KEY, JSON.stringify(fresh));
    return fresh;
  }

  function save() {
    try {
      CR.storage.set(DB_KEY, JSON.stringify(db));
    } catch (e) {
      /* 配额满了也不影响内存演示 */
    }
  }

  // ------------------------------------------------------------------ 总线

  /** 跨窗口同步用的总线：BroadcastChannel 优先，降级 localStorage 事件。 */
  function createBus() {
    if (typeof global.BroadcastChannel === 'function') {
      const ch = new global.BroadcastChannel(BUS_NAME);
      const handlers = [];
      ch.onmessage = (ev) => handlers.forEach((fn) => fn(ev.data));
      return {
        post(evt) {
          ch.postMessage(evt);
        },
        subscribe(fn) {
          handlers.push(fn);
          return () => {
            const i = handlers.indexOf(fn);
            if (i >= 0) handlers.splice(i, 1);
          };
        },
        kind: 'broadcast-channel',
      };
    }
    // 降级：storage 事件（file:// 下两个窗口同源也能收到）
    const handlers = [];
    const key = BUS_NAME + '.event';
    if (global.addEventListener) {
      global.addEventListener('storage', (ev) => {
        if (ev.key !== key || !ev.newValue) return;
        try {
          handlers.forEach((fn) => fn(JSON.parse(ev.newValue)));
        } catch (e) {
          /* ignore */
        }
      });
    }
    return {
      post(evt) {
        CR.storage.set(key, JSON.stringify(Object.assign({ _nonce: Math.random() }, evt)));
      },
      subscribe(fn) {
        handlers.push(fn);
        return () => {
          const i = handlers.indexOf(fn);
          if (i >= 0) handlers.splice(i, 1);
        };
      },
      kind: 'localStorage',
    };
  }

  function postToBus(evt) {
    if (bus) bus.post(evt);
  }

  function onBusEvent(evt) {
    if (!evt || !evt.kind) return;
    const room = evt.room;
    if (!room) return;
    if (evt.kind === 'message') {
      // 别的窗口发的消息：落到本地库，再投给本窗口"正在该房间"的连接
      const list = db.messages[room] || (db.messages[room] = []);
      if (!list.some((m) => m.seq === evt.msg.seq)) {
        list.push(evt.msg);
        if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
        save();
      }
      deliver(room, { type: 'message', room, ...evt.msg });
    } else if (evt.kind === 'presence') {
      applyPresence(room, evt.joins, evt.leaves);
      deliver(room, { type: 'presence', room, joins: evt.joins || [], leaves: evt.leaves || [] });
    } else if (evt.kind === 'typing') {
      deliver(room, { type: 'typing', room, from: evt.from });
    }
  }

  // -------------------------------------------------------------- presence

  function applyPresence(room, joins, leaves) {
    const members = db.members[room] || (db.members[room] = {});
    (joins || []).forEach((u) => {
      if (u && u.id) members[u.id] = u.name || u.id;
    });
    (leaves || []).forEach((id) => {
      delete members[id];
    });
    save();
  }

  function membersList(room) {
    const members = db.members[room] || {};
    return Object.keys(members).map((id) => ({ id, name: members[id] }));
  }

  function isMember(room, userId) {
    const members = db.members[room] || {};
    return Object.prototype.hasOwnProperty.call(members, userId);
  }

  // ---------------------------------------------------------------- 投递

  /** 把一条下行 envelope 投给本窗口所有"正在该房间"的假 socket。 */
  function deliver(room, env) {
    sockets.forEach((sock) => {
      if (!sock.alive || sock.room !== room) return;
      sock._emit(env);
    });
  }

  /** 只投给某个 socket（ack 是私有下行）。 */
  function deliverTo(sock, env) {
    if (sock.alive) sock._emit(env);
  }

  // ------------------------------------------------------------ 假 socket

  function userFromToken(token) {
    const m = /^mock-token-(.+)$/.exec(String(token || ''));
    if (!m) return null;
    const id = m[1];
    for (const name in db.users) {
      if (db.users[name].id === id) return db.users[name];
    }
    return null;
  }

  /**
   * 创建一个假 WebSocket。事件时序刻意模仿浏览器：
   *   token 无效 → 不触发 onopen，直接 onclose(1006)（真实后端此时是 HTTP 401，
   *   浏览器只会给出 1006，所以前端要靠 REST 探针判断"到底是不是 token 失效"）
   *   token 有效 → onopen → 之后可以收发
   */
  function createSocket(url) {
    const token = /[?&]token=([^&]+)/.exec(String(url || ''));
    const user = userFromToken(token ? decodeURIComponent(token[1]) : '');
    socketSeq += 1;
    const sock = {
      id: 'mock-sock-' + socketSeq,
      readyState: 0, // 0 connecting / 1 open / 3 closed
      alive: false,
      room: '',
      user,
      url: String(url || ''),
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      _emit(env) {
        if (!this.alive) return;
        if (CR.config.LOG) console.log('[mock ws recv]', env);
        if (this.onmessage) this.onmessage({ data: JSON.stringify(env) });
      },
      _close(code, reason) {
        if (!this.alive && this.readyState === 3) return;
        this.alive = false;
        this.readyState = 3;
        sockets.delete(this);
        if (this.onclose) this.onclose({ code, reason: reason || '', wasClean: code === 1000 });
      },
      send(text) {
        if (!this.alive) throw new Error('mock socket is not open');
        let frame = null;
        try {
          frame = JSON.parse(text);
        } catch (e) {
          this._emit({ type: 'error', code: 4400, message: 'bad json' });
          return;
        }
        if (CR.config.LOG) console.log('[mock ws send]', frame);
        handleFrame(this, frame);
      },
      close(code, reason) {
        if (this.room) this.leaveRoom(this.room);
        this._close(code == null ? 1000 : code, reason || 'client closed');
      },
      // --- 内部：供 handleFrame 使用 ---
      leaveRoom(room) {
        const meId = this.user ? this.user.id : '';
        const joins = [];
        const leaves = meId ? [meId] : [];
        applyPresence(room, joins, leaves);
        postToBus({ kind: 'presence', room, joins, leaves });
        deliver(room, { type: 'presence', room, joins, leaves });
        this.room = '';
      },
    };
    sockets.add(sock);

    setTimeout(() => {
      if (!user) {
        // 等价于真实后端的 HTTP 401：握手失败
        sock._close(1006, 'unexpected response: 401');
        return;
      }
      sock.alive = true;
      sock.readyState = 1;
      if (sock.onopen) sock.onopen({});
    }, latency());

    return sock;
  }

  // ------------------------------------------------------- C→S 帧的处理

  function handleFrame(sock, frame) {
    const type = frame && frame.type;
    const me = sock.user;
    if (!me) return;

    if (type === 'join') {
      const room = frame.room;
      if (!room) {
        deliverTo(sock, { type: 'error', code: 4400, message: 'room required' });
        return;
      }
      if (!db.rooms.some((r) => r.id === room)) {
        deliverTo(sock, { type: 'error', code: 4400, message: 'room_not_found' });
        return;
      }
      if (sock.room && sock.room !== room) sock.leaveRoom(sock.room);

      const joined = [{ id: me.id, name: me.name }];
      applyPresence(room, joined, []);
      postToBus({ kind: 'presence', room, joins: joined, leaves: [] });
      deliver(room, { type: 'presence', room, joins: joined, leaves: [] });
      sock.room = room;

      // 1) sync：补拉 last_seq 之后的增量（和真实后端一样，先 sync 后 joined）
      const since = frame.last_seq || '';
      const all = db.messages[room] || [];
      const missed = all.filter((m) => !since || CR.util.compareSeq(m.seq, since) > 0);
      const page = missed.slice(Math.max(0, missed.length - SYNC_LIMIT)); // 和真实后端一样有上限
      const lastSeq = page.length ? page[page.length - 1].seq : since;
      deliverTo(sock, {
        type: 'sync',
        room,
        messages: page.map((m) => ({ seq: m.seq, from: m.from, content: m.content, ts: m.ts })),
        last_seq: lastSeq,
      });

      // 2) joined：在线快照
      deliverTo(sock, { type: 'joined', room, members: membersList(room) });

      scheduleDemo(sock, room);
      return;
    }

    if (type === 'leave') {
      if (!sock.room) {
        deliverTo(sock, { type: 'error', code: 4002, message: 'not in a room' });
        return;
      }
      sock.leaveRoom(sock.room);
      return;
    }

    if (type === 'chat') {
      const room = sock.room;
      if (!room || (frame.room && frame.room !== room)) {
        deliverTo(sock, {
          type: 'error',
          code: 4002,
          message: 'join a room first',
          ref: frame.client_msg_id,
        });
        return;
      }
      const cmid = frame.client_msg_id || '';
      const content = frame.content || '';
      if (!cmid) {
        deliverTo(sock, { type: 'error', code: 4400, message: 'client_msg_id required' });
        return;
      }
      if (!content) {
        deliverTo(sock, { type: 'error', code: 4400, message: 'content required', ref: cmid });
        return;
      }
      if (content.length > 4096) {
        deliverTo(sock, { type: 'error', code: 4400, message: 'content too long', ref: cmid });
        return;
      }

      // 幂等：同一个 client_msg_id 只写一次
      const key = room + '|' + cmid;
      if (dedup.has(key)) {
        deliverTo(sock, {
          type: 'ack',
          room,
          client_msg_id: cmid,
          seq: dedup.get(key),
          ts: nowSec(),
        });
        return;
      }

      const ts = nowSec();
      const msg = { seq: newSeq(), from: { id: me.id, name: me.name }, content, ts, client_msg_id: cmid };
      dedup.set(key, msg.seq);

      const list = db.messages[room] || (db.messages[room] = []);
      list.push(msg);
      if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
      save();

      // 真网络一定有往返延迟，这里也故意异步回包：
      // 这样"乐观上屏（发送中）→ ack → 已发送"这条链路在纯 mock 演示时也能看到。
      // 注意 dedup / db 的写入在上面已经同步完成，幂等性不受延迟影响。
      const ackFrame = { type: 'ack', room, client_msg_id: cmid, seq: msg.seq, ts };
      const msgFrame = {
        type: 'message',
        room,
        seq: msg.seq,
        from: msg.from,
        content: msg.content,
        ts: msg.ts,
        client_msg_id: cmid,
      };
      setTimeout(() => {
        deliverTo(sock, ackFrame);
        deliver(room, msgFrame);
      }, latency());
      postToBus({ kind: 'message', room, msg: clone(msg) });
      return;
    }

    if (type === 'typing') {
      const room = sock.room;
      if (!room) {
        deliverTo(sock, { type: 'error', code: 4002, message: 'join a room first' });
        return;
      }
      const from = { id: me.id, name: me.name };
      deliver(room, { type: 'typing', room, from });
      postToBus({ kind: 'typing', room, from });
      return;
    }

    if (type === 'ping') {
      deliverTo(sock, { type: 'pong' });
      return;
    }

    deliverTo(sock, { type: 'error', code: 4400, message: 'unknown type: ' + type });
  }

  // --------------------------------------------------------- 自动演示

  function scheduleDemo(sock, room) {
    if (!autoDemo || !CR.config.MOCK_AUTO_DEMO) return;
    if (demoDone.has(room)) return;
    demoDone.add(room);

    // 2.5s：机器人进房间（演示 presence 增量）
    setTimeout(() => {
      if (!sock.alive || sock.room !== room) return;
      if (isMember(room, 'u_bot')) return;
      const joins = [{ id: 'u_bot', name: '小助手' }];
      applyPresence(room, joins, []);
      postToBus({ kind: 'presence', room, joins, leaves: [] });
      deliver(room, { type: 'presence', room, joins, leaves: [] });
    }, 2500);

    // 6s：机器人发言（演示实时消息 + 未读数/滚动）
    setTimeout(() => {
      if (!sock.alive || sock.room !== room) return;
      botMessage(room, '这是一条 mock 机器人消息：试着断开网络再恢复，消息不会丢也不会重。');
    }, 6000);
  }

  function botMessage(room, content) {
    const msg = {
      seq: newSeq(),
      from: { id: 'u_bot', name: '小助手' },
      content,
      ts: nowSec(),
    };
    const list = db.messages[room] || (db.messages[room] = []);
    list.push(msg);
    if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
    save();
    deliver(room, {
      type: 'message',
      room,
      seq: msg.seq,
      from: msg.from,
      content: msg.content,
      ts: msg.ts,
    });
    postToBus({ kind: 'message', room, msg: clone(msg) });
    return msg;
  }

  // ------------------------------------------------------------ 假 REST

  function requireToken(token) {
    const user = userFromToken(token);
    if (!user) {
      const err = new Error('invalid or expired token');
      err.status = 401;
      err.code = 'unauthorized';
      throw err;
    }
    return user;
  }

  const api = {
    register(username, password) {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          const name = String(username || '').trim();
          if (!name || String(password || '').length < 6) {
            const err = new Error('username required, password min 6 chars');
            err.status = 400;
            err.code = 'bad_request';
            return reject(err);
          }
          if (db.users[name]) {
            const err = new Error('username taken');
            err.status = 400;
            err.code = 'bad_request';
            return reject(err);
          }
          const u = {
            id: 'u_' + Math.random().toString(36).slice(2, 10),
            name,
            password: String(password),
          };
          db.users[name] = u;
          save();
          resolve({ user_id: u.id, created_at: nowSec() });
        }, latency());
      });
    },

    login(username, password) {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          const u = db.users[String(username || '').trim()];
          if (!u || u.password !== String(password || '')) {
            const err = new Error('wrong username or password');
            err.status = 401;
            err.code = 'unauthorized';
            return reject(err);
          }
          resolve({
            token: 'mock-token-' + u.id,
            expires_at: nowSec() + 3600,
            user: { id: u.id, name: u.name },
          });
        }, latency());
      });
    },

    me(token) {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          try {
            const u = requireToken(token);
            resolve({ id: u.id, name: u.name });
          } catch (e) {
            reject(e);
          }
        }, latency());
      });
    },

    listRooms(token) {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          try {
            requireToken(token);
          } catch (e) {
            return reject(e);
          }
          resolve({
            rooms: db.rooms.map((r) => ({
              id: r.id,
              name: r.name,
              member_count: membersList(r.id).length,
            })),
            next_cursor: '',
          });
        }, latency());
      });
    },

    createRoom(token, name) {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          try {
            requireToken(token);
          } catch (e) {
            return reject(e);
          }
          const roomName = String(name || '').trim();
          if (!roomName || roomName.length > 64) {
            const err = new Error('invalid room name');
            err.status = 400;
            err.code = 'bad_request';
            return reject(err);
          }
          const room = { id: roomId(nextRoomNumber()), name: roomName, member_count: 0 };
          db.rooms.push(room);
          db.messages[room.id] = db.messages[room.id] || [];
          db.members[room.id] = db.members[room.id] || {};
          save();
          resolve({ id: room.id, name: room.name, member_count: 0 });
        }, latency());
      });
    },

    getRoom(token, id) {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          try {
            requireToken(token);
          } catch (e) {
            return reject(e);
          }
          const room = db.rooms.find((r) => r.id === id);
          if (!room) {
            const err = new Error('room_not_found');
            err.status = 404;
            err.code = 'room_not_found';
            return reject(err);
          }
          resolve({ id: room.id, name: room.name, member_count: membersList(room.id).length });
        }, latency());
      });
    },

    roomMembers(token, id) {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          try {
            requireToken(token);
          } catch (e) {
            return reject(e);
          }
          if (!db.rooms.some((r) => r.id === id)) {
            const err = new Error('room_not_found');
            err.status = 404;
            err.code = 'room_not_found';
            return reject(err);
          }
          resolve({ members: membersList(id) });
        }, latency());
      });
    },

    /** 与真实后端一致：倒序（新→旧）+ has_more。 */
    roomMessages(token, id, opts) {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          try {
            requireToken(token);
          } catch (e) {
            return reject(e);
          }
          const before = (opts && opts.beforeSeq) || '';
          const limit = (opts && opts.limit) || CR.config.PAGE_SIZE;
          const all = (db.messages[id] || []).slice().sort((a, b) => CR.util.compareSeq(a.seq, b.seq));
          const older = before ? all.filter((m) => CR.util.compareSeq(m.seq, before) < 0) : all;
          const page = older.slice(Math.max(0, older.length - limit));
          const desc = page.reverse().map((m) => ({
            seq: m.seq,
            from: m.from,
            content: m.content,
            ts: m.ts,
          }));
          resolve({ messages: desc, has_more: older.length > page.length });
        }, latency());
      });
    },
  };

  // ---------------------------------------------------------------- 对外

  CR.mock = {
    get _db() {
      return db;
    },
    get _bus() {
      return bus;
    },

    /** 测试用：注入总线（多个 mock 实例共享一个进程内总线）。 */
    useBus(busImpl) {
      bus = busImpl;
      if (bus && bus.subscribe) bus.subscribe(onBusEvent);
    },

    setAutoDemo(on) {
      autoDemo = !!on;
    },

    /** 演示/联调用：主动断掉本窗口所有假连接（模拟网络中断）。 */
    simulateDrop() {
      const victims = Array.from(sockets);
      victims.forEach((s) => s._close(1006, 'mock network drop'));
      return victims.length;
    },

    /** 演示用：往"另一个你待过的房间"推一条消息，用来展示未读角标。 */
    demoOtherRoomMessage(currentRoom) {
      const other = db.rooms.find((r) => r.id !== currentRoom);
      if (!other) return null;
      const content = '（mock 演示）这条消息来自另一个房间，所以左侧会出现未读角标。';
      const msg = { seq: newSeq(), from: { id: 'u_bot', name: '小助手' }, content, ts: nowSec() };
      const list = db.messages[other.id] || (db.messages[other.id] = []);
      list.push(msg);
      if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
      save();
      postToBus({ kind: 'message', room: other.id, msg: clone(msg) });
      // mock 专属演示路径：直接投给本窗口的连接（真实后端一条连接只在一个房间，
      // 所以它不会推别的房间的消息 —— 见 README「已知契约差异」）
      const env = {
        type: 'message',
        room: other.id,
        seq: msg.seq,
        from: msg.from,
        content: msg.content,
        ts: msg.ts,
      };
      sockets.forEach((s) => {
        if (s.alive) s._emit(env);
      });
      return msg;
    },

    /** 测试/重置用：清空并重新种数据。 */
    reset() {
      sockets.forEach((s) => {
        s.alive = false;
        s.readyState = 3;
      });
      sockets.clear();
      demoDone.clear();
      dedup.clear();
      CR.storage.remove(DB_KEY);
      db = load();
      return db;
    },

    createSocket,

    api: {
      // api.js 会以 (token, ...args) 的形式调用，与真实实现保持一致
      register(username, password) {
        return api.register(username, password);
      },
      login(username, password) {
        return api.login(username, password);
      },
      me(token) {
        return api.me(token);
      },
      listRooms(token, params) {
        return api.listRooms(token, params);
      },
      createRoom(token, name) {
        return api.createRoom(token, name);
      },
      getRoom(token, id) {
        return api.getRoom(token, id);
      },
      roomMembers(token, id) {
        return api.roomMembers(token, id);
      },
      roomMessages(token, id, opts) {
        return api.roomMessages(token, id, opts);
      },
    },
  };

  // 初始化：载入数据 + 起总线
  db = load();
  bus = createBus();
  if (bus && bus.subscribe) bus.subscribe(onBusEvent);

  // 关标签页 / 刷新前抢着广播一次 leave。
  //
  // 真实后端是靠"读泵发现连接断了"当场摘 presence 并通知别人的（internal/chat/hub.go）。
  // mock 的"服务端"就活在这个页面里，页面一关它也跟着没了，所以只能趁 unload 之前
  // 尽力喊一声（BroadcastChannel/localStorage 都是尽力而为，喊不到就等下次 join 的快照纠正）。
  // pagehide 和 beforeunload 都挂上：前者在移动端/Safari 更可靠，leaveRoom 自身幂等。
  if (global.addEventListener) {
    const announceLeave = () => {
      sockets.forEach((sock) => {
        if (sock.alive && sock.room) sock.leaveRoom(sock.room);
      });
    };
    global.addEventListener('beforeunload', announceLeave);
    global.addEventListener('pagehide', announceLeave);
  }
})(typeof window !== 'undefined' ? window : globalThis);