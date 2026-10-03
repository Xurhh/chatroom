// k6 压测脚本：setup() 里注册+登录 N 个专属用户，每个 VU 一个，然后压 WebSocket。
//
// 用法：
//   make loadtest                                   # 默认 500VU / 单房间 / 5 分钟
//   VUS=200 DURATION=1m ROOMS=20 make loadtest      # 200VU 均分到 20 个房间（更接近真实拓扑）
//   VUS=500 ROOMS=1 k6 run loadtest/ws.js           # 单房间极限扇出（最坏情况）
//
// ★ 先搞清楚这个脚本在压什么（否则数字很容易被误读）：
//
//   扇出倍数 = VU 数 / 房间数。每个 VU 每 5s 发 1 条，所以
//     入口消息速率 = VUS / 5 条/s
//     下行投递速率 = 入口 × 扇出倍数（500VU 单房间 = 100 条/s 入口 → 约 50000 帧/s 下行）
//     每个 VU 每秒要消费 = 扇出倍数 × 0.2 条
//
//   当"每个 VU 的入站速率"超过 ~30 条/s 时，ack 延迟主要由**压测器自己**的消费能力决定
//   （k6 的 WS 事件派发 + JS 回调扛不住这个洪流，会把连接读缓冲堵住 → 服务端写缓冲
//   回压 → 连 ack 都排在后面）。这时 script 会打印 GENERATOR-BOUND 警告并自动放宽 ack 阈值。
//   要测服务端，请用 ROOMS 把扇出倍数降下来，或把 k6 放到另一台机器上。
//
// 建议同时盯服务端指标（guide 9.3）：
//   curl -s localhost:8080/metrics | grep -E 'ws_(broadcast_dropped|broadcast_duration|connections|messages)'
//   - ws_broadcast_duration_seconds：扇出耗时（P99 < 10ms @ 千连接房间）
//   - ws_broadcast_dropped_total：背压丢弃（正常应远小于投递总量；丢了靠 last_seq 补拉兜底）
//   - goroutine 数 ≈ 2×连接数 + 常数（不涨）、进程 RSS 稳定
import ws from 'k6/ws';
import http from 'k6/http';
import { check, fail } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const VUS = Number(__ENV.VUS || 500);
const ROOMS = Math.max(1, Number(__ENV.ROOMS || 1)); // 房间数：1 = 极限扇出
const WS_URL = __ENV.WS_URL || 'ws://localhost:8080';
// ws:// → http://，wss:// → https://，正好都能用这一个 replace 搞定
const API_URL = __ENV.API_URL || WS_URL.replace(/^ws/, 'http');
const ROOM = __ENV.ROOM || 'lobby'; // ROOMS=1 时用的房间
const INTERVAL_MS = Number(__ENV.INTERVAL_MS || 5000); // 每个 VU 的发送间隔
const PASSWORD = 'loadtest123'; // >= 6 位即可
// 同一房间里出现超过这个时长的 seq 空档，视为"疑似漏收"（正常忙碌房间不该空这么久）
const GAP_MS = Number(__ENV.GAP_MS || 1500);

// 每个 VU 的入站速率超过它 → 数字是压测器自己的锅，不是服务端的
const GENERATOR_BOUND_PER_VU = Number(__ENV.GENERATOR_BOUND || 30);
const perVuInbound = (VUS / ROOMS - 1) / (INTERVAL_MS / 1000);
const generatorBound = perVuInbound > GENERATOR_BOUND_PER_VU;
// 压测器跟不上时，ack 阈值只剩"别离谱到几秒"的意义
const ACK_P95 = Number(__ENV.ACK_P95 || (generatorBound ? 3000 : 500));
// 漏收预算：正常拓扑必须是 0（一帧都不该丢）；压测器自己堵住时给每个 VU 几条的余量
// （服务端背压丢弃是静默的，靠重连时的 last_seq 补拉兜底，见 loadtest/README.md）
const MAX_JUMPS = Number(__ENV.MAX_JUMPS || (generatorBound ? 4 * VUS : 0));

const received = new Counter('ws_messages_received'); // 收到的所有下行帧（含广播洪流）
const sent = new Counter('ws_messages_sent'); // 自己发出去的 chat 条数
const acks = new Counter('ws_acks_total');
const seqJumps = new Counter('ws_seq_jumps_total'); // 疑似漏收次数（启发式，见下）
const ackLatency = new Trend('ws_ack_latency_ms', true);

export const options = {
    vus: VUS,
    duration: __ENV.DURATION || '5m',
    // VU 的 socket 要等到 setTimeout(45min) 才关，正常不会"跑完一个 iteration"，
    // 所以 gracefulStop 缩短到 2s：否则每次压测白等 30s，还会多算 30s 的负载。
    gracefulStop: '2s',
    thresholds: {
        ws_messages_received: ['count>0'],
        ws_acks_total: ['count>0'],
        ws_ack_latency_ms: [`p(95)<${ACK_P95}`],
        // 服务端背压丢弃（量很小）会被这里抓到：正常应该 0，偶尔几条也不算事故
        ws_seq_jumps_total: [`count<=${MAX_JUMPS}`],
    },
};

// 注册 + 登录一个用户，返回 JWT
function getTokenFor(username) {
    const headers = { headers: { 'Content-Type': 'application/json' } };

    // 先注册；用户已存在（409/400 等）也无所谓，反正下一步登录
    http.post(`${API_URL}/api/v1/auth/register`,
        JSON.stringify({ username, password: PASSWORD }), headers);

    const login = http.post(`${API_URL}/api/v1/auth/login`,
        JSON.stringify({ username, password: PASSWORD }), headers);

    const token = (() => {
        try { return login.json('token'); } catch (e) { return null; }
    })();
    check(login, {
        '登录成功': (r) => r.status === 200,
        '返回 token': () => !!token,
    }) || fail(`登录失败 ${username}: status=${login.status} body=${login.body}`);
    return token;
}

// 整个测试只跑一次：批量准备 VUS 个用户（ROOMS>1 时再建好房间，让每个房间人数可控）
export function setup() {
    const tokens = [];
    for (let i = 1; i <= VUS; i++) {
        tokens.push(getTokenFor(`k6_load_${i}`));
        if (i % 100 === 0) console.log(`已登录 ${i}/${VUS} 个用户`);
    }
    console.log(`setup 完成：${tokens.length} 个专属用户`);

    const rooms = [];
    if (ROOMS > 1) {
        const run = Date.now().toString(36);
        for (let i = 1; i <= ROOMS; i++) {
            const res = http.post(`${API_URL}/api/v1/rooms`, JSON.stringify({ name: `bench-${run}-${i}` }), {
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[0]}` },
            });
            let id = null;
            try { id = res.json('id'); } catch (e) { id = null; }
            if (id) rooms.push(id);
        }
        if (rooms.length !== ROOMS) fail(`只建出 ${rooms.length}/${ROOMS} 个房间`);
    }

    const fanout = rooms.length ? VUS / rooms.length : VUS;
    console.log(`负载画像：${VUS} VU / ${rooms.length || 1} 房间 → 每房间约 ${fanout} 人`);
    console.log(`          入口约 ${(VUS / (INTERVAL_MS / 1000)).toFixed(0)} 条/s，` +
        `下行约 ${(VUS / (INTERVAL_MS / 1000) * fanout).toFixed(0)} 帧/s，` +
        `每个 VU 每秒收 ${perVuInbound.toFixed(1)} 条`);
    if (generatorBound) {
        console.warn(`GENERATOR-BOUND：每个 VU 每秒要收 ${perVuInbound.toFixed(1)} 条（> ${GENERATOR_BOUND_PER_VU}），` +
            `k6 自己很可能消费不过来 —— ack 延迟会被压测器放大，不能当作服务端指标。` +
            `建议：ROOMS=${Math.ceil(VUS / 10)} 左右，或把 k6 放到另一台机器。`);
    }
    return { tokens, rooms };
}

/** seq = "<毫秒>-<同一毫秒内的序号>"，取毫秒部分做单调性判断。 */
function seqMs(seq) {
    const ms = Number(String(seq).split('-')[0]);
    return Number.isFinite(ms) ? ms : null;
}

export default function (data) {
    // __VU 从 1 开始；每个 VU 固定用自己那个用户，断线重连也复用同一个
    const token = data.tokens[(__VU - 1) % data.tokens.length];
    const room = data.rooms.length ? data.rooms[(__VU - 1) % data.rooms.length] : ROOM;
    const sentAt = new Map();
    let lastSeqMs = null;
    let lastArrivalAt = 0;

    ws.connect(`${WS_URL}/api/v1/ws?token=${token}`, {}, (socket) => {
        socket.on('open', () => {
            socket.send(JSON.stringify({ type: 'join', room: room, last_seq: '' }));

            socket.setInterval(() => {
                const clientMsgID = `${__VU}-${Date.now()}`;
                sentAt.set(clientMsgID, Date.now());
                sent.add(1);
                socket.send(JSON.stringify({
                    type: 'chat',
                    room: room,
                    client_msg_id: clientMsgID,
                    content: `load test ${__VU}`,
                }));
            }, INTERVAL_MS);
        });

        socket.on('message', (raw) => {
            received.add(1);

            // 廉价过滤：请求/响应里只有 ack / sync 是我们关心的，先 indexOf 再 parse
            const maybeAck = raw.indexOf('"type":"ack"') !== -1;
            const maybeSync = raw.indexOf('"type":"sync"') !== -1;
            if (!maybeAck && !maybeSync && raw.indexOf('"type":"message"') === -1) return;

            let msg = null;
            try { msg = JSON.parse(raw); } catch (e) { return; }

            if (msg.type === 'ack') {
                if (sentAt.has(msg.client_msg_id)) {
                    acks.add(1);
                    ackLatency.add(Date.now() - sentAt.get(msg.client_msg_id));
                    sentAt.delete(msg.client_msg_id);
                }
                return;
            }

            if (msg.type === 'sync') {
                // 加入房间时的历史补拉：这批是旧消息，用它给的 last_seq 重置基线，
                // 否则"旧 → 新"的跳变会被误判成漏收。
                lastSeqMs = seqMs(msg.last_seq);
                lastArrivalAt = 0;
                return;
            }

            // type=message：房间里的广播。seq 在房间内单调递增，出现长时间空档
            // 往往意味着某条广播被背压丢了（服务端 ws_broadcast_dropped_total 是权威计数，
            // 这里是客户端视角的启发式：正常安静房间不会误报，因为只有"前进超过 GAP_MS"才算）。
            if (msg.type === 'message' && msg.seq) {
                const ms = seqMs(msg.seq);
                const now = Date.now();
                if (ms !== null) {
                    // 只有"上一条刚收到不久、这条 seq 却跳了一大截"才算疑似漏收。
                    // 否则安静房间里正常的消息空档会被误判（房间本来就没那么密）。
                    if (lastSeqMs !== null && lastArrivalAt && now - lastArrivalAt <= GAP_MS &&
                        ms - lastSeqMs > GAP_MS) {
                        seqJumps.add(1);
                    }
                    lastSeqMs = ms;
                    lastArrivalAt = now;
                }
            }
        });

        socket.on('close', () => {});
        socket.setTimeout(() => socket.close(), 45 * 60 * 1000);
    });
}