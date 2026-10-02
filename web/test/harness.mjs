/*!
 * test/harness.mjs —— 在 Node 里加载浏览器端 JS 的小工具
 *
 * 前端是"普通 <script> + 全局命名空间"，没有模块系统，所以测试也用最朴素的办法：
 * 用 node:vm 造一个假的浏览器环境（window / localStorage / location / WebSocket…），
 * 把 js/*.js 按顺序执行进去，然后直接调用 CR.* 的接口来断言行为。
 *
 * 这样做的好处：store.js（可靠性逻辑）和 ws.js（连接/重连）完全不碰 DOM，
 * 所以它们的行为可以在没有浏览器的情况下被真实地测试到。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WEB_ROOT = path.resolve(HERE, '..');

/** 假 localStorage（同一份实例可以给两个"窗口"共享）。 */
export function createStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => void map.set(String(k), String(v)),
    removeItem: (k) => void map.delete(String(k)),
    clear: () => map.clear(),
    get length() {
      return map.size;
    },
  };
}

/**
 * 进程内的"跨窗口总线"，语义对齐 BroadcastChannel：
 * 发出去的事件不会回给自己，只会给别的 endpoint。
 */
export function createSharedBus() {
  const endpoints = new Set();
  return {
    createEndpoint() {
      const self = { fn: null };
      endpoints.add(self);
      return {
        kind: 'test-bus',
        post(evt) {
          endpoints.forEach((h) => {
            if (h !== self && typeof h.fn === 'function') h.fn(evt);
          });
        },
        subscribe(fn) {
          self.fn = fn;
          return () => endpoints.delete(self);
        },
      };
    },
  };
}

/** 校验用：记录所有请求的 fetch 替身。 */
export function createFetchStub(routes = []) {
  const calls = [];
  const stub = async (url, init) => {
    const call = {
      url: String(url),
      method: (init && init.method) || 'GET',
      headers: (init && init.headers) || {},
      body: init && init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const route = routes.find((r) => call.url.includes(r.match) && (!r.method || r.method === call.method));
    const res = route
      ? route.response
      : { status: 200, body: {} };
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      async text() {
        return res.body === undefined ? '' : JSON.stringify(res.body);
      },
    };
  };
  stub.calls = calls;
  return stub;
}

/** 可编程的 WebSocket 替身（MOCK=false 时测握手/关闭码用）。 */
export function createWebSocketStub(script = {}) {
  const instances = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.closedByClient = false;
      instances.push(this);
      const onCreated = script.onCreated;
      if (typeof onCreated === 'function') setTimeout(() => onCreated(this), 0);
    }
    send(text) {
      this.sent.push(text);
      if (typeof script.onSend === 'function') script.onSend(this, text);
    }
    close(code, reason) {
      this.closedByClient = true;
      this.readyState = 3;
      if (typeof script.onClientClose === 'function') script.onClientClose(this, code, reason);
      if (this.onclose) this.onclose({ code: code || 1000, reason: reason || '' });
    }
    // --- 测试驱动用 ---
    _open() {
      this.readyState = 1;
      if (this.onopen) this.onopen({});
    }
    _message(obj) {
      if (this.onmessage) this.onmessage({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) });
    }
    _serverClose(code, reason) {
      this.readyState = 3;
      if (this.onclose) this.onclose({ code, reason: reason || '' });
    }
  }
  FakeWebSocket.created = instances;
  FakeWebSocket.script = script;
  return FakeWebSocket;
}

/**
 * 造一个浏览器环境。
 * @param {object} opts {storage, fetch, WebSocket, BroadcastChannel, location}
 */
export function createEnv(opts = {}) {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.console = opts.console || console;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.setInterval = setInterval;
  sandbox.clearInterval = clearInterval;
  sandbox.URLSearchParams = URLSearchParams;
  sandbox.encodeURIComponent = encodeURIComponent;
  sandbox.decodeURIComponent = decodeURIComponent;
  sandbox.location = opts.location || { search: '', protocol: 'http:', href: 'http://localhost:5173/' };
  sandbox.localStorage = opts.storage || createStorage();
  sandbox.crypto = opts.crypto || { randomUUID: () => 'uuid-' + Math.random().toString(36).slice(2) };
  sandbox.navigator = { userAgent: 'node-test' };
  if (opts.fetch) sandbox.fetch = opts.fetch;
  if (opts.WebSocket) sandbox.WebSocket = opts.WebSocket;
  if (opts.BroadcastChannel) sandbox.BroadcastChannel = opts.BroadcastChannel;

  // window 级事件：mock.js 会在 beforeunload/pagehide 时广播 leave（真后端靠读泵发现断线），
  // 所以测试也得能真正派发这些事件。
  const winListeners = {};
  sandbox.addEventListener = (type, fn) => {
    (winListeners[type] = winListeners[type] || []).push(fn);
  };
  sandbox.removeEventListener = (type, fn) => {
    const list = winListeners[type] || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  };
  sandbox.dispatchEvent = (type, extra) => {
    const ev = Object.assign({ type, target: sandbox, preventDefault() {}, stopPropagation() {} }, extra);
    (winListeners[type] || []).slice().forEach((fn) => fn(ev));
  };
  vm.createContext(sandbox);

  const loaded = [];
  const env = {
    sandbox,
    loaded,
    /** 按顺序加载 web/ 下的文件（相对路径，例如 'js/config.js'）。 */
    load(...relPaths) {
      relPaths.forEach((rel) => {
        const file = path.isAbsolute(rel) ? rel : path.join(WEB_ROOT, rel);
        const code = fs.readFileSync(file, 'utf8');
        vm.runInContext(code, sandbox, { filename: path.relative(WEB_ROOT, file) });
        loaded.push(rel);
      });
      return sandbox.CR;
    },
    /** 加载"核心链路"：config → store → mock → api → ws。 */
    loadCore() {
      return env.load('js/config.js', 'js/store.js', 'js/mock.js', 'js/api.js', 'js/ws.js');
    },
    get CR() {
      return sandbox.CR;
    },
  };
  return env;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 把 vm 上下文里造出来的对象/数组转成宿主 realm 的普通值。
 * 原因：vm 里创建的对象原型链属于另一个 realm，assert.deepStrictEqual 会因为
 * "prototype 不同"而报 "Values have same structure but are not reference-equal"。
 */
export function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** 轮询等待条件成立（默认 2s 超时）。 */
export async function waitFor(fn, timeout = 2000, label = 'condition') {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = !!fn();
    } catch (e) {
      ok = false;
    }
    if (ok) return true;
    if (Date.now() - start > timeout) throw new Error('waitFor 超时: ' + label);
    await sleep(2);
  }
}

export { vm, fs, path };