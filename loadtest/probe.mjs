// 独立探针：证明"ack 延迟到底是服务端的，还是 k6 自己的"。
//
// 用法（开两个终端）：
//   终端 1：VUS=500 ROOMS=1 make loadtest          # 制造单房间扇出洪水
//   终端 2：node loadtest/probe.mjs                # 同房间的 ack 延迟（默认 30s）
//
// 原理：探针是另一个进程（Node），它和 k6 的 VU 一样是房间里的普通成员，
// 收到同样多的广播，但它的事件循环能轻松消费 100 条/s。
//   探针 p50 几毫秒 + k6 med 几百毫秒  → 延迟在压测器（k6）侧，服务端没问题
//   两边都几百毫秒                     → 才需要去看服务端（/metrics、pprof）
//
// 环境变量：API_BASE（默认 http://localhost:8080）、ROOM（默认 lobby）、
//           PROBE_MS（默认 30000）、PROBE_INTERVAL（默认 1000）
const API = process.env.API_BASE || 'http://localhost:8099';
const WS = API.replace(/^http/, 'ws');
const ROOM = process.env.ROOM || 'lobby';
const DURATION_MS = Number(process.env.PROBE_MS || 30000);
const INTERVAL = Number(process.env.PROBE_INTERVAL || 1000);

const user = 'probe_' + Date.now().toString(36);
await fetch(`${API}/api/v1/auth/register`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: user, password: 'probe123' }),
});
const login = await (await fetch(`${API}/api/v1/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: user, password: 'probe123' }),
})).json();

const sock = new WebSocket(`${WS}/api/v1/ws?token=${login.token}`);
const sentAt = new Map();
const ackMs = [];
let inbound = 0, inboundWindow = 0, acks = 0, sinceWindow = Date.now();
let firstEcho = null, echoAfterAck = [];

sock.onopen = () => sock.send(JSON.stringify({ type: 'join', room: ROOM, last_seq: '' }));
sock.onmessage = (ev) => {
  inbound++; inboundWindow++;
  const s = typeof ev.data === 'string' ? ev.data : String(ev.data);
  if (s.indexOf('"type":"ack"') !== -1) {
    try {
      const m = JSON.parse(s);
      if (sentAt.has(m.client_msg_id)) {
        const ms = Number(process.hrtime.bigint() - sentAt.get(m.client_msg_id)) / 1e6;
        ackMs.push(ms); acks++;
        sentAt.delete(m.client_msg_id);
      }
    } catch (e) {}
    return;
  }
  if (s.indexOf('"type":"message"') !== -1 && firstEcho === null) firstEcho = Date.now();
};

const timer = setInterval(() => {
  const id = 'probe-' + Date.now();
  sentAt.set(id, process.hrtime.bigint());
  sock.send(JSON.stringify({ type: 'chat', room: ROOM, client_msg_id: id, content: 'probe' }));
}, INTERVAL);

const reporter = setInterval(() => {
  const now = Date.now();
  const secs = (now - sinceWindow) / 1000;
  const pct = (p) => (ackMs.length ? ackMs.slice().sort((a, b) => a - b)[Math.floor(ackMs.length * p)] : 0);
  console.log(`[probe] 本秒收到的广播 ${(inboundWindow / secs).toFixed(1)} 条/s | 累计 ack ${acks} 个 ` +
    `p50=${pct(0.5).toFixed(1)}ms p95=${pct(0.95).toFixed(1)}ms max=${(ackMs.length ? Math.max(...ackMs) : 0).toFixed(1)}ms`);
  inboundWindow = 0; sinceWindow = now;
}, 5000);

setTimeout(() => {
  clearInterval(timer); clearInterval(reporter);
  const sorted = ackMs.slice().sort((a, b) => a - b);
  const q = (p) => (sorted.length ? sorted[Math.floor(sorted.length * p)].toFixed(1) : 'n/a');
  console.log(`[probe] 结束：收到广播 ${inbound} 条，ack ${acks} 个，p50=${q(0.5)}ms p95=${q(0.95)}ms max=${q(0.999)}ms`);
  sock.close();
  process.exit(0);
}, DURATION_MS);
