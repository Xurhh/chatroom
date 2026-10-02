// k6 压测脚本（guide 9.3）：500 并发连接，每连接每 5s 发一条。
//
// 用法：
//   TOKEN=$(make smoke 里登录拿到的 jwt) WS_URL=ws://localhost:8080 \
//     k6 run loadtest/ws.js
//
// 压测时盯 4 个指标（guide 9.3）：
//   goroutine 数 ≈ 2×连接数 + 常数（不涨）
//   ws_broadcast_dropped_total 0 或增速远低于消息量
//   ws_broadcast_duration_seconds P99 < 10ms（千连接房间）
//   进程 RSS 稳定
import ws from 'k6/ws';
import { Counter, Trend } from 'k6/metrics';

const received = new Counter('ws_messages_received');
const ackLatency = new Trend('ws_ack_latency_ms', true);

export const options = {
  vus: Number(__ENV.VUS || 500),
  duration: __ENV.DURATION || '5m',
  thresholds: {
    ws_messages_received: ['count>0'],
  },
};

const WS_URL = __ENV.WS_URL || 'ws://localhost:8080';
const ROOM = __ENV.ROOM || 'lobby';
const TOKEN = __ENV.TOKEN;

export default function () {
  if (!TOKEN) {
    throw new Error('缺少 TOKEN 环境变量：先登录拿 JWT 再压测');
  }
  const sentAt = new Map();

  ws.connect(`${WS_URL}/api/v1/ws?token=${TOKEN}`, {}, (socket) => {
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'join', room: ROOM, last_seq: '' }));

      socket.setInterval(() => {
        const clientMsgID = `${__VU}-${Date.now()}`;
        sentAt.set(clientMsgID, Date.now());
        socket.send(JSON.stringify({
          type: 'chat',
          room: ROOM,
          client_msg_id: clientMsgID,
          content: `load test ${__VU}`,
        }));
      }, 5000);
    });

    socket.on('message', (raw) => {
      received.add(1);
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'ack' && sentAt.has(msg.client_msg_id)) {
          ackLatency.add(Date.now() - sentAt.get(msg.client_msg_id));
          sentAt.delete(msg.client_msg_id);
        }
      } catch (e) {
        // 忽略解析失败：压测里只看吞吐与延迟
      }
    });

    socket.on('close', () => {});
    // 45 分钟自动收尾，避免 script 永远不结束
    socket.setTimeout(() => socket.close(), 45 * 60 * 1000);
  });
}