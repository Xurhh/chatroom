/*!
 * js/store.js —— 全局状态 + 纯逻辑（不碰 DOM，可在 Node 里直接测试）
 *
 * 设计要点：
 *   1. 单一 state 对象 + subscribe/notify，组件只读 state、只通过 store 的方法改 state；
 *   2. 所有"可靠性交互"（seq 去重、乐观消息、ack、sync 合并、未读数）都在这里实现，
 *      因为它们是最容易出错的部分，放在 DOM 之外才能被自动化测试覆盖；
 *   3. 需要 localStorage 的地方一律经过 CR.storage（不可用时退化为内存，file:// 也能跑）。
 *
 * 消息的三个 ID（务必区分，见 explain.md 6.1）：
 *   client_msg_id —— 客户端生成的幂等键，用来把"乐观上屏"和服务端消息对上号
 *   seq           —— 服务端权威序号（形如 "1730000000123-0"），字符串，绝不转数字
 *   user.id       —— 用户身份
 */
(function (global) {
  'use strict';

  const CR = (global.CR = global.CR || {});

  // ---------------------------------------------------------------- 工具函数

  function escapeHtml(input) {
    return String(input == null ? '' : input).replace(/[&<>"']/g, (ch) => {
      switch (ch) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        default:
          return '&#39;';
      }
    });
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  // ts 是 Unix 秒（后端 Message.TS 的定义，见 internal/chat/protocol.go）
  function toDate(tsSec) {
    const n = Number(tsSec);
    return new Date((Number.isFinite(n) && n > 0 ? n : Date.now() / 1000) * 1000);
  }

  function formatTime(tsSec) {
    const d = toDate(tsSec);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function formatDay(tsSec) {
    const d = toDate(tsSec);
    const today = new Date();
    const sameDay =
      d.getFullYear() === today.getFullYear() &&
      d.getMonth() === today.getMonth() &&
      d.getDate() === today.getDate();
    if (sameDay) return '今天';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /**
   * 比较两个 seq。
   * seq 形如 "毫秒时间戳-序号"。毫秒位数一致时词典序等价于时间序，
   * 但为了不被"位数变化"咬到（例如 "999-0" vs "1000-0"），这里按数字比较两段。
   */
  function compareSeq(a, b) {
    const as = String(a == null ? '' : a);
    const bs = String(b == null ? '' : b);
    if (as === bs) return 0;
    const ap = as.split('-');
    const bp = bs.split('-');
    const am = Number(ap[0]);
    const bm = Number(bp[0]);
    if (Number.isFinite(am) && Number.isFinite(bm) && am !== bm) return am < bm ? -1 : 1;
    if (ap[0] !== bp[0]) return ap[0] < bp[0] ? -1 : 1;
    const anx = Number(ap[1] || 0);
    const bnx = Number(bp[1] || 0);
    if (anx !== bnx) return anx < bnx ? -1 : 1;
    return as < bs ? -1 : 1;
  }

  function uuid() {
    try {
      if (global.crypto && typeof global.crypto.randomUUID === 'function') {
        return global.crypto.randomUUID();
      }
    } catch (e) {
      /* 非安全上下文时降级 */
    }
    return 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function throttle(fn, ms) {
    let last = 0;
    let timer = null;
    const wrapped = function () {
      const args = arguments;
      const now = Date.now();
      const remain = ms - (now - last);
      if (remain <= 0) {
        last = now;
        fn.apply(null, args);
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          last = Date.now();
          fn.apply(null, args);
        }, remain);
      }
    };
    wrapped.cancel = function () {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    return wrapped;
  }

  function nowSec() {
    return Math.floor(Date.now() / 1000);
  }

  const util = {
    escapeHtml,
    formatTime,
    formatDay,
    compareSeq,
    uuid,
    throttle,
    nowSec,
  };
  CR.util = util;

  // ------------------------------------------------------- storage（带降级）

  const memoryStore = {};
  const storage = {
    get(key) {
      try {
        return global.localStorage ? global.localStorage.getItem(key) : memoryStore[key] || null;
      } catch (e) {
        return memoryStore[key] || null;
      }
    },
    set(key, value) {
      try {
        if (global.localStorage) global.localStorage.setItem(key, value);
        else memoryStore[key] = value;
      } catch (e) {
        memoryStore[key] = value;
      }
    },
    remove(key) {
      try {
        if (global.localStorage) global.localStorage.removeItem(key);
        else delete memoryStore[key];
      } catch (e) {
        delete memoryStore[key];
      }
    },
  };
  CR.storage = storage;

  const SESSION_KEY = 'cr.session';

  // ------------------------------------------------------------------ state

  function emptyState() {
    return {
      booted: false,
      view: 'login', // login | chat
      session: { token: '', user: null },
      rooms: [], // [{id, name, member_count}]
      nextCursor: '',
      currentRoom: '', // roomId
      messages: {}, // roomId -> [msg] 升序（按 seq）
      pending: {}, // roomId -> [乐观消息 {clientMsgId, content, ts, from, status, seq, createdAt}]
      members: {}, // roomId -> [{id, name}]
      unread: {}, // roomId -> number
      hasMore: {}, // roomId -> bool
      loadingMore: {}, // roomId -> bool
      notices: {}, // roomId -> [{id, text, ts}] 系统提示（居中灰字，仅当前会话可见）
      typing: {}, // roomId -> {id, name, at}
      conn: { status: 'idle', retry: 0, lastError: '' }, // idle|connecting|online|offline|unauthorized
      toast: null, // {id, text, kind}
    };
  }

  const state = emptyState();
  const listeners = [];
  let toastSeq = 0;
  let noticeSeq = 0;

  function subscribe(fn) {
    listeners.push(fn);
    return function unsubscribe() {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  function notify() {
    listeners.slice().forEach((fn) => {
      try {
        fn(state);
      } catch (e) {
        console.error('[store] listener error', e);
      }
    });
  }

  // ------------------------------------------------------------- 小工具方法

  function roomMessages(roomId) {
    return state.messages[roomId] || (state.messages[roomId] = []);
  }

  function roomPending(roomId) {
    return state.pending[roomId] || (state.pending[roomId] = []);
  }

  function findPending(clientMsgId) {
    for (const roomId in state.pending) {
      const hit = state.pending[roomId].find((p) => p.clientMsgId === clientMsgId);
      if (hit) return { roomId, item: hit };
    }
    return null;
  }

  function findMessageBySeq(roomId, seq) {
    return roomMessages(roomId).find((m) => m.seq === seq) || null;
  }

  // ------------------------------------------------------------ 登录态/视图

  const store = {
    state,

    subscribe,
    notify,

    setSession(token, user) {
      state.session = { token, user };
      state.view = 'chat';
      storage.set(SESSION_KEY, JSON.stringify({ token, user }));
      notify();
    },

    restoreSession() {
      const raw = storage.get(SESSION_KEY);
      if (!raw) return null;
      try {
        const saved = JSON.parse(raw);
        if (saved && saved.token && saved.user) {
          state.session = { token: saved.token, user: saved.user };
          state.view = 'chat';
          return saved;
        }
      } catch (e) {
        storage.remove(SESSION_KEY);
      }
      return null;
    },

    clearSession() {
      state.session = { token: '', user: null };
      state.view = 'login';
      storage.remove(SESSION_KEY);
      notify();
    },

    setView(view) {
      state.view = view;
      notify();
    },

    // ------------------------------------------------------------- 房间列表

    setRooms(rooms, nextCursor) {
      const incoming = rooms || [];
      const byId = {};
      state.rooms.forEach((r) => {
        byId[r.id] = r;
      });
      incoming.forEach((r) => {
        const merged = Object.assign({}, byId[r.id], r);
        // 有 presence 实时数据的房间，人数以实时为准：REST 是请求那一刻的快照，
        // 拿它覆盖实时值会让刚跳动的数字"倒回去"。
        if (state.members[r.id] && byId[r.id]) merged.member_count = byId[r.id].member_count;
        byId[r.id] = merged;
      });
      // 保持后端顺序：先出现的排前面
      const order = incoming.map((r) => r.id);
      state.rooms.forEach((r) => {
        if (order.indexOf(r.id) < 0) order.push(r.id);
      });
      state.rooms = order.map((id) => byId[id]).filter(Boolean);
      state.nextCursor = nextCursor || '';
      notify();
    },

    upsertRoom(room) {
      if (!room || !room.id) return;
      const i = state.rooms.findIndex((r) => r.id === room.id);
      if (i >= 0) state.rooms[i] = Object.assign({}, state.rooms[i], room);
      else state.rooms.unshift(room);
      notify();
    },

    roomById(id) {
      return state.rooms.find((r) => r.id === id) || null;
    },

    setCurrentRoom(roomId) {
      state.currentRoom = roomId;
      state.unread[roomId] = 0;
      notify();
    },

    // --------------------------------------------------------------- 消息流

    /**
     * 用服务端返回的一页历史更新本地列表（首次进入房间用）。
     * 注意：
     *   - REST 历史是倒序（新→旧），调用方负责 reverse，这里只做排序与去重；
     *   - 这里是**并集**而不是替换：本地可能已经有 WS sync 补拉来的更新消息、
     *     或之前翻页加载的更早消息，替换会把它们丢掉。
     */
    setHistory(roomId, messages, hasMore) {
      const merged = {};
      (state.messages[roomId] || []).forEach((m) => {
        if (m && m.seq) merged[m.seq] = m;
      });
      (messages || []).forEach((m) => {
        if (m && m.seq) merged[m.seq] = m;
      });
      state.messages[roomId] = Object.keys(merged)
        .map((seq) => merged[seq])
        .sort((a, b) => compareSeq(a.seq, b.seq));
      if (typeof hasMore === 'boolean') state.hasMore[roomId] = hasMore;
      reconcilePending(roomId);
      notify();
    },

    /** 向上翻页：把更早的一页并进本地列表（保持升序、去重）。 */
    prependHistory(roomId, messages, hasMore) {
      const list = roomMessages(roomId);
      const seen = {};
      list.forEach((m) => {
        seen[m.seq] = true;
      });
      let added = 0;
      (messages || []).forEach((m) => {
        if (m && m.seq && !seen[m.seq]) {
          seen[m.seq] = true;
          list.push(m);
          added++;
        }
      });
      list.sort((a, b) => compareSeq(a.seq, b.seq));
      if (typeof hasMore === 'boolean') state.hasMore[roomId] = hasMore;
      reconcilePending(roomId);
      notify();
      return added;
    },

    setHasMore(roomId, hasMore) {
      state.hasMore[roomId] = !!hasMore;
      notify();
    },

    setLoadingMore(roomId, loading) {
      state.loadingMore[roomId] = !!loading;
      notify();
    },

    /**
     * 收到一条实时消息（WS type=message 或 mock 推来的消息）。
     * 返回 'dup' | 'replaced' | 'added'：
     *   - 已有同 seq            → 'dup'（不重复渲染）
     *   - 命中本地乐观消息 cmid → 'replaced'（用服务端的 seq/ts 替换占位）
     *   - 其余                  → 'added'
     */
    addMessage(msg) {
      if (!msg || !msg.seq) return 'dup';
      const roomId = msg.room || state.currentRoom;
      const list = roomMessages(roomId);
      if (list.some((m) => m.seq === msg.seq)) {
        // 这条 seq 已经在本地了（通常是 REST 历史先到），
        // 但它可能正是某条乐观消息的"真身"，所以仍要对账一次，把占位摘掉。
        reconcilePending(roomId);
        notify();
        return 'dup';
      }

      let result = 'added';
      if (msg.client_msg_id) {
        const pending = roomPending(roomId);
        const i = pending.findIndex((p) => p.clientMsgId === msg.client_msg_id);
        if (i >= 0) {
          pending.splice(i, 1);
          result = 'replaced';
        }
      }
      list.push({
        seq: msg.seq,
        from: msg.from || null,
        content: msg.content || '',
        ts: msg.ts || nowSec(),
      });
      list.sort((a, b) => compareSeq(a.seq, b.seq));

      // 不是当前房间 → 未读 +1（见 README「已知契约差异」：真实后端只推当前房间）
      if (roomId !== state.currentRoom) {
        state.unread[roomId] = (state.unread[roomId] || 0) + 1;
      }
      notify();
      return result;
    },

    /**
     * 合并 type=sync 的补拉结果：按 seq 去重合并，返回新增条数。
     * 断线重连、背压丢弃、切换房间都靠它兜底（guide 2.10）。
     */
    applySync(roomId, messages, lastSeq) {
      const list = roomMessages(roomId);
      const seen = {};
      list.forEach((m) => {
        seen[m.seq] = true;
      });
      let added = 0;
      (messages || []).forEach((m) => {
        if (!m || !m.seq || seen[m.seq]) return;
        seen[m.seq] = true;
        list.push({ seq: m.seq, from: m.from || null, content: m.content || '', ts: m.ts || nowSec() });
        if (m.client_msg_id) {
          const pending = roomPending(roomId);
          const i = pending.findIndex((p) => p.clientMsgId === m.client_msg_id);
          if (i >= 0) pending.splice(i, 1);
        }
        added++;
      });
      if (added) list.sort((a, b) => compareSeq(a.seq, b.seq));
      reconcilePending(roomId);
      state.conn.lastSyncAt = Date.now();
      if (lastSeq) state.conn.lastSeq = lastSeq;
      notify();
      return added;
    },

    /** 本地已收到的最大 seq（join 时作为 last_seq 上送，服务端据此补拉）。 */
    lastSeqFor(roomId) {
      const list = state.messages[roomId] || [];
      if (!list.length) return '';
      return list[list.length - 1].seq;
    },

    messageCountFor(roomId) {
      return (state.messages[roomId] || []).length;
    },

    // ------------------------------------------------------- 乐观消息与 ack

    addPending(roomId, clientMsgId, content, from) {
      roomPending(roomId).push({
        clientMsgId,
        content,
        from: from || state.session.user,
        ts: nowSec(),
        createdAt: Date.now(),
        status: 'sending', // sending | sent | failed
        seq: '',
      });
      notify();
    },

    /** 收到 ack：把乐观消息标记为已发送并记录 seq。返回是否命中。 */
    applyAck(clientMsgId, seq) {
      const hit = findPending(clientMsgId);
      if (!hit) return false;
      hit.item.status = 'sent';
      hit.item.seq = seq || '';
      notify();
      return true;
    },

    markFailed(clientMsgId) {
      const hit = findPending(clientMsgId);
      if (!hit) return false;
      hit.item.status = 'failed';
      notify();
      return true;
    },

    /**
     * 超时扫描：返回所有"发送中且超过 ACK_TIMEOUT"的消息（由 main.js 定时调用）。
     * 单独抽出来是为了能在测试里注入时间，不必真的等 10 秒。
     */
    sweepTimeouts(timeoutMs, now) {
      const t = now == null ? Date.now() : now;
      const limit = timeoutMs == null ? CR.config.ACK_TIMEOUT : timeoutMs;
      const expired = [];
      for (const roomId in state.pending) {
        state.pending[roomId].forEach((p) => {
          if (p.status === 'sending' && t - p.createdAt >= limit) {
            p.status = 'failed';
            expired.push(p.clientMsgId);
          }
        });
      }
      if (expired.length) notify();
      return expired;
    },

    /** 点击重试：复用同一个 client_msg_id 与原始 content（guide 8.2 的硬要求）。 */
    retryPending(clientMsgId) {
      const hit = findPending(clientMsgId);
      if (!hit) return null;
      hit.item.status = 'sending';
      hit.item.createdAt = Date.now();
      notify();
      return { clientMsgId: hit.item.clientMsgId, roomId: hit.roomId, content: hit.item.content };
    },

    pendingFor(roomId) {
      return (state.pending[roomId] || []).slice();
    },

    /** 渲染用：历史消息 + 系统提示 + 乐观消息（乐观消息没有 seq，统一排在最后）。 */
    timelineFor(roomId) {
      const history = (state.messages[roomId] || []).map((m) => Object.assign({ kind: 'message' }, m));
      const notices = (state.notices[roomId] || []).map((n) => Object.assign({ kind: 'notice' }, n));
      const pending = (state.pending[roomId] || []).map((p) =>
        Object.assign({ kind: 'pending' }, p)
      );
      return history.concat(notices, pending);
    },

    /** 系统提示（"xxx 加入了房间"之类），只在本地会话里显示，不入历史。 */
    addNotice(roomId, text) {
      const list = state.notices[roomId] || (state.notices[roomId] = []);
      noticeSeq += 1;
      list.push({ id: noticeSeq, text: String(text), ts: nowSec() });
      if (list.length > 50) list.splice(0, list.length - 50);
      notify();
    },

    noticeCountFor(roomId) {
      return (state.notices[roomId] || []).length;
    },

    // --------------------------------------------------------------- 成员

    /**
     * 把在线人数回写到房间列表里的那一项（左栏 "N 人"）。
     *
     * 背景：GET /rooms 返回的 member_count 是服务端按 presence 现算的**快照**
     * （见 internal/room/service.go 的 List），请求完就固定了；而右栏成员列表是
     * WS presence 驱动的。如果只显示 REST 快照，别人进出房间时左栏人数就会一直是旧值，
     * 非得刷新页面才更新（这正是"左栏人数要刷新、右栏不用"的原因）。
     * 所以这里让 presence 成为当前房间人数的权威来源，REST 值只作为初始值。
     */
    syncRoomCount(roomId, count) {
      if (!roomId || typeof count !== 'number' || count < 0) return false;
      const room = state.rooms.find((r) => r.id === roomId);
      if (!room || room.member_count === count) return false;
      room.member_count = count;
      return true;
    },

    setMembers(roomId, users) {
      const seen = {};
      const list = [];
      (users || []).forEach((u) => {
        if (!u || !u.id || seen[u.id]) return;
        seen[u.id] = true;
        list.push({ id: u.id, name: u.name || u.id });
      });
      list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      state.members[roomId] = list;
      // joined 快照 / GET /rooms/{id}/members 都是"这个房间当前在线的人"，顺手同步人数
      this.syncRoomCount(roomId, list.length);
      notify();
    },

    applyPresence(roomId, joins, leaves) {
      const list = state.members[roomId] || (state.members[roomId] = []);
      const seen = {};
      list.forEach((u) => {
        seen[u.id] = true;
      });
      (joins || []).forEach((u) => {
        if (u && u.id && !seen[u.id]) {
          seen[u.id] = true;
          list.push({ id: u.id, name: u.name || u.id });
        }
      });
      const left = {};
      (leaves || []).forEach((id) => {
        left[id] = true;
      });
      const next = list.filter((u) => !left[u.id]);
      next.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      state.members[roomId] = next;
      this.syncRoomCount(roomId, next.length);
      notify();
    },

    membersFor(roomId) {
      return (state.members[roomId] || []).slice();
    },

    // ------------------------------------------------------------- 未读数

    bumpUnread(roomId) {
      state.unread[roomId] = (state.unread[roomId] || 0) + 1;
      notify();
    },

    clearUnread(roomId) {
      state.unread[roomId] = 0;
      notify();
    },

    unreadFor(roomId) {
      return state.unread[roomId] || 0;
    },

    totalUnread() {
      return Object.keys(state.unread).reduce((sum, id) => sum + (state.unread[id] || 0), 0);
    },

    // ------------------------------------------------------------ 连接状态

    setConn(status, retry, lastError) {
      state.conn = {
        status,
        retry: retry == null ? 0 : retry,
        lastError: lastError || '',
        lastSyncAt: state.conn ? state.conn.lastSyncAt : 0,
        lastSeq: state.conn ? state.conn.lastSeq : '',
      };
      notify();
    },

    conn() {
      return state.conn;
    },

    // -------------------------------------------------------------- typing

    setTyping(roomId, user) {
      state.typing[roomId] = { id: user && user.id, name: (user && user.name) || '', at: Date.now() };
      notify();
    },

    clearTyping(roomId) {
      if (!state.typing[roomId]) return;
      delete state.typing[roomId];
      notify();
    },

    typingLabel(roomId) {
      const t = state.typing[roomId];
      if (!t) return '';
      if (state.session.user && t.id === state.session.user.id) return '';
      return t.name ? t.name + ' 正在输入…' : '对方正在输入…';
    },

    // --------------------------------------------------------------- toast

    toast(text, kind) {
      toastSeq += 1;
      state.toast = { id: toastSeq, text: String(text), kind: kind || 'info' };
      notify();
      return state.toast.id;
    },

    clearToast(id) {
      if (state.toast && (id == null || state.toast.id === id)) {
        state.toast = null;
        notify();
      }
    },

    // -------------------------------------------------------------- 测试用

    _reset() {
      Object.assign(state, emptyState());
      listeners.length = 0;
      toastSeq = 0;
    },
  };

  /**
   * 对账：把"已经在历史里"的乐观消息摘掉，避免切房间来回时重复渲染。
   *
   * 背景：REST 历史（/rooms/{id}/messages）按 guide 5.3 的契约不返回 client_msg_id，
   * 所以只能用"同一用户 + 内容相同 + 时间接近"来判断。只处理已经 ack 过、
   * 或者早就超时的条目，绝不误杀刚刚发出的乐观消息。
   */
  function reconcilePending(roomId) {
    const pending = state.pending[roomId];
    if (!pending || !pending.length) return;
    const list = state.messages[roomId] || [];
    const me = state.session.user ? state.session.user.id : null;
    const window_ = 10; // 秒：客户端时间与服务端时间的容忍差

    // 为什么连"发送中"的也要对账：REST 历史是权威记录，它里面已经有这条消息，
    // 说明服务端早就写进去了（我们的 ack 只是还没回来）。这时候如果留着占位，
    // 就会出现"历史里一条 + 待发列表里一条"的重复渲染 —— 这正是本函数存在的理由。
    //
    // 用贪心消费而不是简单的 some()：连发两条内容相同的消息时，
    // 一条历史只能抵消一条占位，不能把两条都吃掉（那会丢掉真正未确认的消息）。
    const used = {};
    list.forEach((m, i) => {
      if (m && m.from) used[i] = false;
    });

    state.pending[roomId] = pending.filter((p) => {
      const fromId = p.from && p.from.id ? p.from.id : me;
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (!m || !m.from || used[i]) continue;
        if (m.from.id !== fromId) continue;
        if (m.content !== p.content) continue;
        if (Math.abs(Number(m.ts) - Number(p.ts)) > window_) continue;
        used[i] = true; // 这条历史认领了这条占位
        return false;
      }
      return true;
    });
  }

  CR.store = store;
})(typeof window !== 'undefined' ? window : globalThis);