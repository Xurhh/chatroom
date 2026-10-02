/*!
 * js/config.js —— 全局配置（唯一需要改的文件）
 *
 * 三个核心配置项（guide 8.2）：
 *   API_BASE —— REST 基地址，例如 http://localhost:8080
 *   WS_BASE  —— WebSocket 基地址，例如 ws://localhost:8080
 *   MOCK     —— true = 使用内置假后端（无需任何后端即可完整演示）
 *               false = 连真实 Go 后端
 *
 * MOCK 的取值规则（优先级从高到低）：
 *   1) URL 参数 ?mock=1 / ?mock=0 强制指定（便于联调时来回切）
 *   2) 用浏览器双击打开（file:// 协议）→ 自动 true，保证"双击即可演示、无控制台报错"
 *   3) 其余情况 → false（静态服务器 + 真实后端，这是对接生产的主路径）
 */
(function (global) {
  'use strict';

  var CR = (global.CR = global.CR || {});

  // 三个必须的常量：改这里即可切换环境（比如部署到别的域名）。
  var API_BASE = 'http://localhost:8080';
  var WS_BASE = 'ws://localhost:8080';

  function resolveMock() {
    var q = null;
    try {
      q = new URLSearchParams(global.location.search).get('mock');
    } catch (e) {
      q = null;
    }
    if (q !== null) return q !== '0'; // ?mock=1 打开，?mock=0 关闭
    try {
      if (global.location.protocol === 'file:') return true; // 双击打开 → 自动 mock
    } catch (e) {
      /* ignore */
    }
    return false;
  }

  var MOCK = resolveMock();

  CR.config = {
    // ---- 必填三项 ----
    API_BASE: API_BASE,
    WS_BASE: WS_BASE,
    MOCK: MOCK,

    // ---- 可调参数（都有合理默认值，一般不用改）----
    PAGE_SIZE: 50, // 历史消息每页条数（后端上限 200）
    ACK_TIMEOUT: 10000, // 发出后多久没收到 ack 判定"发送失败"（guide 8.2：10s）
    TYPING_THROTTLE: 2000, // typing 事件节流：最多 1 次 / 2s
    TYPING_HIDE: 3000, // 收到 typing 后多久自动消失
    WS_RECONNECT_BASE: 1000, // 重连退避基数：1s
    WS_RECONNECT_MAX: 30000, // 重连退避上限：30s
    WS_JITTER: 0.2, // 退避抖动 ±20%，避免惊群（guide 8.2）
    MOCK_LATENCY_MIN: 60, // mock 模拟网络延迟（毫秒）
    MOCK_LATENCY_MAX: 180,
    MOCK_AUTO_DEMO: true, // mock 模式下的自动演示（机器人发言 / 假用户进出）
    LOG: false, // 打开后在控制台打印收发帧，联调时很有用
  };

  // 便捷方法：把相对路径拼成完整地址。
  // 注意读的是 CR.config.API_BASE / WS_BASE 这两个属性（而不是上面的局部变量），
  // 这样在控制台里 CR.config.WS_BASE = 'ws://other:8080' 就能立刻换后端，
  // 测试（web/test/e2e.mjs）也是靠这一点把前端指到临时端口上的。
  CR.config.apiURL = function (path) {
    return String(CR.config.API_BASE || API_BASE).replace(/\/+$/, '') + path;
  };
  CR.config.wsURL = function (path) {
    return String(CR.config.WS_BASE || WS_BASE).replace(/\/+$/, '') + path;
  };

  if (CR.config.LOG) {
    console.log('[config] API_BASE=%s WS_BASE=%s MOCK=%s', API_BASE, WS_BASE, MOCK);
  }
})(typeof window !== 'undefined' ? window : globalThis);