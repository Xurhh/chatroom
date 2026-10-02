# chatroom · Go WebSocket 聊天室骨架

按 `guide.md`（Go 聊天室开发笔记）搭出的可运行骨架：**M0（单机多人在线）已经跑通，
M1（Redis Stream 权威记录 + Pub/Sub 扇出 + seq 补拉）主链路也已经接上**，
剩下的都是标了 `TODO(Mx)` 的增量工作。

- 接口契约见 `openapi.md`（= guide 第 5 章）
- 每个文件顶部/关键分支都标了对应的 guide 章节号，方便对照阅读
- `go build ./...`、`go vet ./...`、`go test -race ./...` 全绿

## 快速开始

```bash
# 1) 起 Redis（只有 Redis 是外部依赖；M0 纯内存模式其实不需要它）
make up

# 2) 起服务（:8080，pprof 在 :6060，指标在 /metrics）
make run

# 3) 冒烟：注册 → 登录 → 房间列表
make smoke
```

登录拿到的 `token` 就是 WS 的入场券：

```bash
# 需要 websocat 或 wscat 之类的 WS 客户端
websocat "ws://localhost:8080/api/v1/ws?token=<jwt>"
{"type":"join","room":"lobby","last_seq":""}     # 收到 sync + joined
{"type":"chat","room":"lobby","client_msg_id":"m1","content":"hello"}   # 收到 message + ack
```

### 前端

前端在 `web/`（原生 HTML/CSS/JS，无框架、无构建、无需 `npm install`）：

```bash
# 方式一：静态服务器（推荐，可连真后端；端口 5173 与后端默认跨域白名单一致）
make web            # → http://localhost:5173/

# 方式二：直接双击 web/index.html（file:// 下自动进入 mock 模式，不需要后端）

make webtest        # 前端自动化测试（59 个用例，全走 mock，不需要后端）
make web-e2e        # 前端 → 真后端端到端（14 步，前置：make up && make run）
```

mock 模式预置账号 `alice/alice123`、`bob/bob12345`，可开两个窗口演示互发、断线重连补拉、
未读角标等。细节（配置项、跨域、mock 场景、验收自查结果）见 `web/README.md`。

## 目录结构（对齐 guide 0.4 的目标结构）

```text
cmd/server/          main.go（装配 + 优雅关停）、pprof.go
internal/
  api/               REST handler、WS 入口、JWT 中间件、CORS、路由装配
  authn/             JWT 签发/校验
  chat/              并发核心：Hub / Client / 双 pump / 协议处理 / 扇出入口
  room/              房间业务（元数据存 Redis，在线人数来自 presence）
  store/             Redis 封装：Stream 历史、dedup、presence、房间 meta、Pub/Sub 适配
  config/            环境变量
deploy/              Dockerfile、docker-compose.yml、k8s/*.yaml
loadtest/ws.js       k6 压测脚本（guide 9.3）
web/                 前端（原生 HTML/CSS/JS，guide 第 8 章；含 test/ 自动化测试）
  index.html         页面骨架            js/api.js   唯一的 HTTP 出口
  css/style.css      全部样式            js/ws.js    唯一的 WebSocket 单例（含重连）
  js/config.js       配置项              js/store.js 全局状态 + 可靠性逻辑
  js/mock.js         mock 假后端          js/components/ 四个渲染模块
```

分层纪律：**`internal/chat` 不 import `internal/store`**。存储能力通过
`internal/chat/ports.go` 的接口注入，所以并发逻辑可以脱离 Redis 做单测；
`store` 反向依赖 `chat` 只为复用 `chat.Record` 与实现端口，依赖方向单一不成环。

## 三条主链路

| 链路 | 入口 | 代码位置 |
| --- | --- | --- |
| REST | `/api/v1/*` | `internal/api/handlers.go` + `router.go` |
| WS 建连 | `GET /api/v1/ws?token=`（先鉴权再 Upgrade） | `internal/api/ws.go` |
| 消息写路径 | 幂等占位 → XADD 拿 seq → PUBLISH → ack | `internal/chat/handlers.go` `handleChat` |
| 扇出 | Redis Pub/Sub → `RunFanout` → 本地 Hub | `internal/chat/fanout.go` + `internal/store/fanout.go` |

M0 与 M1 的分叉只有一处：`chat.Deps.Store == nil` 时是 M0 纯内存（本地伪 seq、
`PublishLocal` 广播、不补拉）；接上 `store.Store` 后自动走 M1 全链路。

## 环境变量

见 `.env.example`，生产对应 `deploy/k8s/config.yaml`。最常用的几个：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ADDR` | `:8080` | HTTP 监听地址 |
| `APP_ENV` | `dev` | Redis key 前缀 `chat:{env}:` |
| `REDIS_ADDR` | `localhost:6379` | Redis 地址 |
| `JWT_SECRET` | dev 占位值 | 生产必须换（`openssl rand -hex 32`） |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | CORS + WS CheckOrigin 白名单 |
| `DEFAULT_ROOM` | `lobby` | 启动时确保存在的房间 |
| `PPROF_ADDR` | `127.0.0.1:6060` | 内网 pprof，置空关闭 |
| `DRAIN_DELAY` | `8s` | 摘流后等 LB 传播（guide 7.4） |

## 刻意与 guide 代码不同的几处

骨架沿用 guide 第 3 章的并发结构，但修掉了 4 个会真出问题的地方，读代码时请留意：

1. **`Hub.Start()` 而不是 `go hub.Run()`**：`WaitGroup.Add(1)` 挪到 `go run()` 之前。
   guide 3.2 把 `Add` 放在 `Run` 内部，`Close` 里的 `Wait` 可能先返回，随后就并发遍历了 `rooms`。
2. **两个 pump 会 `clientsWG.Done()`，且 `Add(2)` 放在 `Hub.Join` 里**：
   guide 3.2/3.3 只有 `Add` 没有 `Done`，照抄的话 `hub.Wait()` 永远不返回；
   而 `Add` 必须在启动 pump 之前完成，否则 `Done` 可能先于 `Add`。
3. **`Client.Send` 永不 `close`**：guide 3.2 用 `close(c.Send)` 通知 writePump，
   但只要还有别的 goroutine（比如刚被判定慢消费者时仍在处理消息的 readPump）执行
   `select { case c.Send <- … }`，就存在 send on closed channel 的 panic 窗口。
   这里改用 `done` channel 通知退出，投递侧从此不可能 panic。
4. **限流器是每连接一个**：guide 3.3 用包级 `var limiter`，等于所有连接共用一个令牌桶；
   骨架把它放进 `Client`，配合 `Options.RatePerSec/RateBurst` 可配。

另外两处小改动：`Client.RoomID` 变成原子访问器 `Room()`（`join` 可以切房间，必须防数据竞争）；
两个 pump 导出为 `ReadPump`/`WritePump` 并额外提供 `Start()`，因为 WS handler 在 `api` 包里。

## 测试与压测

```bash
make test        # 单测：含 goleak goroutine 泄漏检测
make race        # go test -race（guide 10 的必做项）
make vet
make loadtest    # k6，需要 TOKEN / WS_URL 环境变量

# 需要真实 Redis 的集成测试（Store 的 Stream/dedup/presence/meta 行为）
REDIS_TEST_ADDR=localhost:6379 go test ./internal/store/ -run Integration -v
```

测试用假连接（`internal/chat/testutil_test.go`）覆盖了扇出、背压踢人、房间切换、
幂等重发、落库失败回滚、M0/M1 两条写路径；`internal/api/ws_test.go` 用 `httptest`
起了真实路由做 WS 端到端（建连 → join → 发言 → ack/广播）。

## TODO 地图（按里程碑）

| 里程碑 | 已有 | 待补（代码里搜 `TODO(M1)` / `TODO(M2)`） |
| --- | --- | --- |
| M0 | Hub/双泵/心跳/优雅关停/广播/限流 | 无明显缺口 |
| M1 | Stream 历史、dedup 幂等、presence、Pub/Sub 扇出、seq 补拉 | 用户表落 DB + bcrypt；presence 定时清理（`store.CleanupPresence`）；房间列表去掉 N+1；按房间动态订阅替代常驻 PSubscribe |
| M2 | 探针、排水关停、Ingress/HPA/PDB、docker-compose | `automaxprocs`（`cmd/server/main.go` 里有注释位置）、`go:embed` 前端、访问日志中间件 |
| M3 | 协议层已与实现解耦（seq/ack/sync 不变） | 换 Kafka/NATS、冷数据落 MySQL/ClickHouse、网关与逻辑分层 |

## 现有接口一览

| Method | Path | 认证 |
| --- | --- | --- |
| POST | `/api/v1/auth/register`、`/api/v1/auth/login` | ✗ |
| GET | `/api/v1/users/me` | ✓ |
| GET/POST | `/api/v1/rooms` | ✓ |
| GET | `/api/v1/rooms/{id}`、`/api/v1/rooms/{id}/members`、`/api/v1/rooms/{id}/messages` | ✓ |
| GET | `/api/v1/ws?token=<jwt>` | query token |
| GET | `/healthz`、`/readyz`、`/metrics` | ✗ |
| GET | `:6060/debug/pprof/*` | 内网端口 |

细节与 JSON 示例以 `openapi.md`（guide 第 5 章）为准。