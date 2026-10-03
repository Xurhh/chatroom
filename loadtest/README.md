# 压测（k6）

```bash
make loadtest                                     # 默认 500 VU / 单房间 / 5 分钟（最坏情况扇出）
VUS=200 DURATION=2m ROOMS=20 k6 run loadtest/ws.js # 200 VU 均分到 20 个房间（更接近真实拓扑）
```

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `VUS` | 500 | 并发连接数（setup 里为每个 VU 注册+登录一个专属用户） |
| `DURATION` | `5m` | 压测时长 |
| `ROOMS` | 1 | 房间数；`1` = 所有人在一个房间（极限扇出） |
| `INTERVAL_MS` | 5000 | 每个 VU 的发消息间隔 |
| `ACK_P95` | 500（压测器跟不上时自动放宽到 3000） | ack 延迟阈值 |
| `MAX_JUMPS` | 0（压测器跟不上时放宽到 4×VUS） | 允许的"疑似漏收"次数 |
| `GAP_MS` | 1500 | seq 空档多久算疑似漏收（只在消息密集时判定） |
| `WS_URL` / `API_URL` | `ws://localhost:8080` | 目标 |

## 怎么读这些数字（很容易看错）

**扇出放大是这个脚本最重要的性质**：

```text
入口速率   = VUS / INTERVAL_MS × 1000          条/s      ← 真正"业务量"
下行投递   = 入口速率 × (VUS / ROOMS)          帧/s      ← 服务端要写出去的帧
每个 VU 收 = (VUS / ROOMS - 1) / (INTERVAL_MS/1000)  条/s ← 压测器自己的负担
```

以默认配置（500 VU / 1 房间 / 5s）为例：入口只有 **100 条/s**，但每个 VU 每秒要收 **100 条**，
下行 **5 万帧/s（约 10 MB/s）**。此时：

- `ws_messages_received ≈ 5 千万/5 分钟` 不是"服务端处理了 5 千万条消息"，
  而是 100 条/s 被放大了 500 倍；
- **`ws_ack_latency_ms` 主要由压测器自己的消费能力决定**，不是服务端指标。
  脚本会在"每个 VU 每秒 > 30 条"时打印 `GENERATOR-BOUND` 警告并放宽阈值。

要评估服务端容量：**降低扇出倍数**（`ROOMS` 调大）或把 k6 放到另一台机器上。
另外 k6 输出里的 `No script iterations fully finished` 是正常的：
VU 的 socket 要等 `setTimeout(45min)` 才关，一个 iteration 不会自己结束。

## 独立探针：一眼看清延迟在谁身上

```bash
# 终端 1：制造洪水
VUS=500 ROOMS=1 make loadtest
# 终端 2：同房间的 ack 延迟（另一个进程，不是 k6）
node loadtest/probe.mjs            # API_BASE / ROOM / PROBE_MS 可调
```

`loadtest/probe.mjs` 是房间里的一个普通成员，收同样多的广播，但 Node 的事件循环
轻松消费 100 条/s。**探针几毫秒而 k6 几百毫秒 → 问题在压测器**；
两边都慢才需要去看服务端。

## 2026-10 的一次实测归因（结论：先怀疑压测器，再怀疑服务端）

同机（12 线程 WSL2 + Go 服务端 + Redis + k6）跑了四组对照，每组 40s、500 VU：

| 组 | 拓扑 | 每个 VU 入站 | ack 中位 | ack p95 | 下行帧/s | 服务端 CPU | k6 CPU | 扇出丢弃 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 500 VU / 1 房间 | ~98 条/s | 509ms | 721ms | 49,223 | 101%（1 核） | 166% | 513 |
| B | 500 VU / **50 房间** | ~2 条/s | **24ms** | **46ms** | 1,070 | **11%** | **15%** | **0** |
| C | A + 收到消息不计数 | ~98 条/s | 542ms | 748ms | — | 83% | 109% | 280 |
| D | A + 发送间隔 10s | ~49 条/s | 599ms | 806ms | 24,246 | 34% | 63% | 13 |

- **B 是关键对照**：连接数、发送速率、机器、服务端完全相同，只是把 500 人拆成 50 个房间
  （扇出 500× → 10×），ack 延迟直接掉到 24ms。所以"500 个连接"本身毫无压力。
- **C 排除了 k6 指标开销**（去掉 `Counter.add` 几乎没变化）。
- **D 说明它不是"按流量线性排队"**：流量减半，延迟没降 —— 是压测器消费不过来把连接堵住，
  服务端 256 深的发送缓冲成了一个固定长度的延迟线，连 ack 都排在洪流后面。

**独立探针（决定性证据）**：在同样的 500 VU 单房间洪水里，另起一个 **Node** 进程连进同一房间，
它每秒收到同样多的广播（102 条/s），测出的 ack 延迟：

```text
[probe] 本秒收到的广播 102.1 条/s | p50=4.2ms   ← Node 探针
k6 同一时间窗：              ws_ack_latency_ms med=641ms p(95)=907ms
```

同一个服务端、同一个房间、同一时刻：Node 看到 **4ms**，k6 看到 **641ms**。
结论：默认配置下的 ack 延迟是 **k6 侧的假象**；服务端的 ack 路径（min 2ms）是健康的。

### 服务端自己看到的（`/metrics`）

```bash
curl -s localhost:8080/metrics | grep -E 'ws_(broadcast_dropped|broadcast_duration|connections)'
```

| 指标 | 500 人单房间（A） | 50 房间 × 10 人（B） |
| --- | --- | --- |
| `ws_broadcast_duration_seconds` 中位 | ≤0.5ms（83.6% 的扇出） | ≤0.5ms（99.5%） |
| 扇出 p95 / p99 | 4ms / 约 16ms | <1ms / 约 1ms |
| `ws_broadcast_dropped_total` | 513 / 357 万帧 = 0.014% | 0 |
| 被踢的慢消费者 | 0 | 0 |
| goroutine / RSS | **1014 = 2×500 + 14，56s 内恒定不涨**，RSS 55–57MB 平稳 | 同上（本地 fanout 更轻） |
| 全部断开后 | **goroutine 回落 13**，RSS 仍 ~56MB | — |

goroutine 数正好是"2×连接数 + 常数"且长时间不涨、断连后回落到 13
（readPump/writePump 各一条，没有泄漏），这是 guide 9.3 要求的两条检查项。

扇出本身是健康的（0.65ms 均值），但 500 人房间里 p99 会摸到 16ms，
**略高于 guide 9.3 给千连接房间定的 P99 < 10ms 目标**，长尾来自 500 次非阻塞投递
+ 高负载下的调度抖动。要更精确的 p99 需要更细的桶（当前是 ExponentialBuckets 粗桶）。

## 两个真实的小问题（都不是"电脑太差"）

1. **连接风暴会被拒**：500 个 VU 在 t=0 同时连，服务端 6ms 内打了 87 条
   `register queue full, rejecting connection`（`Options.RegisterBuf=64`，
   见 [internal/chat/hub.go](../internal/chat/hub.go) 的 `Join`）。
   `Join` 失败会发 Close **1013 (TryAgainLater)**，客户端按退避重连，所以功能上安全，
   但压测里表现为 `ws_sessions=663`（多了 163 次重连）。
   真实场景下前端有抖动退避，不会这么整齐地同时连；如果要更抗风暴，可以
   把 `RegisterBuf` 调大（每项只是一个指针）或把这个值做成环境变量。
2. **背压丢弃是静默的**：连接写不出去时（`Send` 缓冲 256 满）服务端丢帧并
   `ws_broadcast_dropped_total++`；客户端只能靠重连时的 `last_seq` 补拉发现。
   本次 0.014%，且只在单房间极限扇出 + 压测器自己堵住时出现。
   脚本的 `ws_seq_jumps_total` 就是客户端视角的启发式检测（正常拓扑要求为 0）。

顺带一个观察：一条 `chat` 的 ack 要等三次 Redis 往返（`DedupClaim` → `XADD` → `PUBLISH`）
才发出，这也是 ack 的最小延迟是 2-3ms 而不是亚毫秒的原因。若要让发送者更快看到 ack，
可以把 ack 提到 `PUBLISH` 之前（对发送者来说少等一次往返，广播顺序不变）。