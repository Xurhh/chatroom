/*!
 * js/ws.js —— WebSocket 单例封装（new WebSocket 只允许出现在这个文件里）
 *
 * 职责（guide 8.2「WebSocket 客户端」一节）：
 *   - 单例：整个页面只有一条连接
 *   - 断线自动重连：指数退避 1s → 2s → 4s → … → 30s 封顶，每次 ±20% 抖动
 *   - 连接成功或收到任何服务端消息后重置退避计数
 *   - Close 4001 → 不重连，回调 onUnauthorized（main.js 清登录态回登录页）
 *   - 其它关闭码（1000/4008/1006…）→ 自动重连；重连成功后由 main.js 重新 join（带 last_seq）
 *   - 浏览器自动回 Ping/Pong，前端不需要实现任何协议层心跳
 *
 * 重要补充（真实后端的握手细节）：
 *   token 失效时后端返回的是 HTTP 401，握手就失败了，浏览器只会给出 close code=1006，
 *   前端无法从 WebSocket API 读到 401。所以这里在"从未成功握手"时用一次 REST 探针
 *   （setAuthProbe，由 main.js 接到 CR.api.me()）来区分"token 失效"和"网络不通"。
 */
(function (global) {
  'use strict';

  const CR = (global.CR = global.CR || {});

  const handlers = {}; // type -> [fn]
  let sock = null;
  let token = '';
  let manualClose = false;
  let everOpened = false; // 本次连接是否成功握手过
  let attempt = 0; // 连续失败次数（退避用）
  let retryTimer = null;
  let authProbe = null; // () => Promise<boolean>，true=token 有效
  let lastProbeAt = 0;
  let lastProbeOk = true;
  let closedByServer = false;

  const state = {
    status: 'idle', // idle | connecting | online | offline | unauthorized
    retry: 0,
    lastCloseCode: 0,
    lastCloseReason: '',
    nextDelay: 0,
  };

  function on(type, fn) {
    (handlers[type] = handlers[type] || []).push(fn);
    return function off() {
      const list = handlers[type] || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  function emit(type, payload) {
    (handlers[type] || []).slice().forEach((fn) => {
      try {
        fn(payload);
      } catch (e) {
        console.error('[ws] handler error for ' + type, e);
      }
    });
    if (type !== 'frame') emit('frame', { type, payload });
  }

  function setStatus(status, retry, extra) {
    state.status = status;
    state.retry = retry == null ? 0 : retry;
    if (extra) Object.assign(state, extra);
    emit('status', Object.assign({}, state));
  }

  function wsURL() {
    return CR.config.wsURL('/api/v1/ws') + '?token=' + encodeURIComponent(token);
  }

  function clearRetryTimer() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  /** 退避延迟：min(1s * 2^(n-1), 30s) ±20% 抖动。 */
  function backoffDelay(n) {
    const base = Math.min(
      CR.config.WS_RECONNECT_BASE * Math.pow(2, Math.max(0, n - 1)),
      CR.config.WS_RECONNECT_MAX
    );
    const jitter = base * CR.config.WS_JITTER * (Math.random() * 2 - 1);
    return Math.max(50, Math.round(base + jitter));
  }

  function openSocket() {
    clearRetryTimer();
    if (!token) return;
    everOpened = false;
    closedByServer = false;
    setStatus(attempt > 0 ? 'offline' : 'connecting', attempt);

    try {
      sock = CR.config.MOCK
        ? CR.mock.createSocket(wsURL())
        : new global.WebSocket(wsURL());
    } catch (e) {
      console.error('[ws] create socket failed', e);
      scheduleReconnect();
      return;
    }

    sock.onopen = handleOpen;
    sock.onmessage = handleMessage;
    sock.onclose = handleClose;
    sock.onerror = function (e) {
      // 浏览器在 error 之后一定会跟一个 close，重连逻辑统一放在 handleClose；
      // 用 'socketerror' 这个名字是为了不和服务端下行的 {type:'error'} 撞车。
      emit('socketerror', e);
    };
  }

  function handleOpen() {
    everOpened = true;
    attempt = 0;
    setStatus('online', 0, { nextDelay: 0 });
    emit('open', {});
  }

  function handleMessage(ev) {
    attempt = 0; // 收到任何服务端消息都重置退避（guide 8.2）
    let frame = null;
    try {
      frame = JSON.parse(ev.data);
    } catch (e) {
      console.warn('[ws] 无法解析的下行帧', ev.data);
      return;
    }
    if (!frame || !frame.type) return;
    if (CR.config.LOG) console.log('[ws recv]', frame);
    emit(frame.type, frame);
  }

  function handleClose(ev) {
    const code = ev && ev.code ? ev.code : 1006;
    const reason = (ev && ev.reason) || '';
    state.lastCloseCode = code;
    state.lastCloseReason = reason;
    sock = null;
    emit('close', { code, reason });

    if (manualClose) {
      setStatus('idle', 0);
      return;
    }
    if (code === 4001) {
      // token 失效：不重连，交给 main.js 清登录态
      setStatus('unauthorized', 0, { lastCloseCode: code });
      emit('unauthorized', { code, reason });
      return;
    }
    if (!everOpened && typeof authProbe === 'function') {
      // 握手就失败了：可能只是后端没起/网络不通，也可能是 token 失效（后端返回 HTTP 401）
      probeAuth((ok) => {
        if (ok) scheduleReconnect();
        else {
          setStatus('unauthorized', 0, { lastCloseCode: code });
          emit('unauthorized', { code, reason });
        }
      });
      return;
    }
    scheduleReconnect();
  }

  function probeAuth(cb) {
    const now = Date.now();
    if (now - lastProbeAt < 5000) return cb(lastProbeOk); // 5s 内不重复探
    lastProbeAt = now;
    Promise.resolve()
      .then(() => authProbe())
      .then((ok) => {
        lastProbeOk = !!ok;
        cb(lastProbeOk);
      })
      .catch(() => {
        // 探针自己都失败了（后端不可达）→ 当作网络问题，继续重连
        lastProbeOk = true;
        cb(true);
      });
  }

  function scheduleReconnect() {
    if (manualClose || !token) return;
    attempt += 1;
    const delay = backoffDelay(attempt);
    setStatus('offline', attempt, { nextDelay: delay });
    clearRetryTimer();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      openSocket();
    }, delay);
  }

  // ------------------------------------------------------------------ 对外

  const ws = {
    on,

    /** 建立连接（重复调用会先关掉旧连接）。 */
    connect(t) {
      if (t) token = t;
      if (!token) return;
      manualClose = false;
      attempt = 0;
      if (sock) {
        try {
          sock.close(1000, 'reconnect');
        } catch (e) {
          /* ignore */
        }
        sock = null;
      }
      openSocket();
    },

    /** 主动关闭（退出登录）：不再自动重连。 */
    close() {
      manualClose = true;
      clearRetryTimer();
      attempt = 0;
      const s = sock;
      sock = null;
      if (s) {
        try {
          s.close(1000, 'client logout');
        } catch (e) {
          /* ignore */
        }
      }
      setStatus('idle', 0);
    },

    isOpen() {
      return !!sock && sock.readyState === 1;
    },

    status() {
      return Object.assign({}, state);
    },

    /** 发送一个 JSON 对象；未连接时返回 false（调用方决定要不要报错）。 */
    send(obj) {
      if (!ws.isOpen()) return false;
      const text = JSON.stringify(obj);
      if (CR.config.LOG) console.log('[ws send]', obj);
      try {
        sock.send(text);
        return true;
      } catch (e) {
        console.warn('[ws] send failed', e);
        return false;
      }
    },

    join(room, lastSeq) {
      return ws.send({ type: 'join', room, last_seq: lastSeq || '' });
    },

    leave(room) {
      return ws.send({ type: 'leave', room });
    },

    chat(room, clientMsgId, content) {
      return ws.send({ type: 'chat', room, client_msg_id: clientMsgId, content });
    },

    typing(room) {
      return ws.send({ type: 'typing', room });
    },

    ping() {
      return ws.send({ type: 'ping' });
    },

    /**
     * 注册"token 是否有效"的探针（main.js 接到 CR.api.me()）。
     * 实现约定：resolve(true) 有效；resolve(false) / 401 失效；reject 表示无法判断。
     */
    setAuthProbe(fn) {
      authProbe = fn;
    },

    _state: state,
    _attempt: () => attempt,
  };

  CR.ws = ws;
})(typeof window !== 'undefined' ? window : globalThis);