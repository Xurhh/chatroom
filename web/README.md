# web/ —— 聊天室前端

原生 HTML5 + CSS3 + JavaScript（ES6+）实现，**不用任何框架、不用构建工具、不需要 npm install**。
双击 `index.html` 就能跑，也能用任意静态服务器托管；配置一个开关即可在"内置 mock 后端"和
"真实 Go 后端"之间切换。

```
web/
├── index.html                 页面骨架（登录视图 + 聊天视图）
├── css/style.css              全部样式（三栏布局 / 气泡 / 抽屉 / 响应式）
├── js/
│   ├── config.js              配置项（API_BASE / WS_BASE / MOCK + 可调参数）
│   ├── store.js               全局状态、订阅通知、可靠性逻辑（seq 去重 / 乐观消息 / 未读）
│   ├── mock.js                mock 假后端（内存数据 + 假 socket + 跨窗口总线）
│   ├── api.js                 所有 HTTP 请求（fetch 只出现在这里）
│   ├── ws.js                  WebSocket 单例（new WebSocket 只出现在这里，含重连）
│   ├── components/            roomList / messageList / memberList / toast
│   └── main.js                入口：事件绑定、视图切换、把上面几层接起来
├── test/                      自动化测试（Node 内置 test runner + vm，无第三方依赖）
│   ├── harness.mjs            假浏览器环境（window/localStorage/fetch/WebSocket + 跨窗口总线）
│   ├── dom.mjs                极简 DOM 垫片（解析真实 index.html，够 components/main 跑起来）
│   └── *.test.mjs / e2e.mjs   见下面「测试说明」
└── README.md
```

脚本用**普通 `<script>` 顺序引入并共享 `window.CR` 全局命名空间**（不是 ES Module），
加载顺序有依赖，不要调整：`config → store → mock → api → ws → components/* → main`。

---

## 1. 两种启动方式

### 方式 A：双击 `index.html`（`file://` 协议）

直接双击打开即可。此时会自动进入 **mock 模式**（因为 `file://` 下没有后端可连，
而且很多浏览器的 `file://` 页面不允许跨域请求 `http://localhost:8080`），
用任意用户名注册/登录就能完整演示收发消息。

> 为什么不用 ES Module：`file://` 下 `import` 会被 CORS 策略拦住，页面直接白屏。
> 用普通脚本 + 全局命名空间是"双击就能跑"的前提。这也是 `README` 特意说明两种运行方式差异的原因。

### 方式 B：静态服务器（推荐，可连真后端）

```bash
# 在本目录的上一级执行（也就是仓库根目录）
python3 -m http.server 5173 --directory web
# 或： make web
```

然后访问 <http://localhost:5173/>。

**端口请用 5173**：本后端默认的跨域白名单就是 `http://localhost:5173`
（`ALLOWED_ORIGINS`，同时用于 CORS 和 WS 的 `CheckOrigin`），换端口就要同时改后端环境变量。

| 差别 | `file://` 双击 | 静态服务器 |
| --- | --- | --- |
| 默认模式 | 自动 mock | 连真实后端（`?mock=1` 可强制 mock） |
| 能否连 `http://localhost:8080` | 通常不行（跨域被拦） | 可以（后端需放行本站来源） |
| 推荐用途 | 快速看 UI / 演示可靠性交互 | 与 Go 后端联调 |

`?mock=` 可以覆盖默认值：`http://localhost:5173/?mock=1` 用假后端，
`file:///.../index.html?mock=0` 用真后端。

---

## 2. `js/config.js` 配置说明

下面三个是 guide §8.2 约定的配置项（文件顶部，改完刷新页面即可）：

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `API_BASE` | `http://localhost:8080` | REST 基地址。所有请求打到 `${API_BASE}/api/v1/...` |
| `WS_BASE` | `ws://localhost:8080` | WebSocket 基地址。连 `${WS_BASE}/api/v1/ws?token=<jwt>` |
| `MOCK` | `false` | `true`=用 `js/mock.js` 的内存假后端，无需任何后端；`false`=连真实后端 |

`MOCK` 的**实际取值**按下面的优先级决定（这样既满足"默认 false"，又满足"双击无报错"）：

```
?mock=1 / ?mock=0 显式指定  >  file:// 协议自动 true  >  默认 false
```

其余可调参数（都有合理默认值，一般不用动）：
`PAGE_SIZE=50`（每页消息数）、`ACK_TIMEOUT=10000`（10s 没收到 ack 标记发送失败）、
`TYPING_THROTTLE=2000` / `TYPING_HIDE=3000`（正在输入节流与自动消失）、
`WS_RECONNECT_BASE=1000` / `WS_RECONNECT_MAX=30000` / `WS_JITTER=0.2`（退避与抖动）、
`MOCK_LATENCY_MIN/MAX`（mock 模拟网络延迟）、`LOG=false`（打开后控制台打印收发帧）。

也可以在浏览器控制台里临时改（`apiURL/wsURL` 读的是当前属性值，改完立刻生效）：

```js
CR.config.WS_BASE = 'ws://192.168.1.10:8080';
CR.config.API_BASE = 'http://192.168.1.10:8080';
```

---

## 3. 与本地 Go 后端联调

1. 起 Redis 和后端（仓库根目录）：

   ```bash
   make up            # docker compose 起 Redis
   make run           # 监听 :8080，pprof :6060
   ```

2. **放行前端来源**（跨域必需）。默认白名单是 `http://localhost:5173`，
   如果你用别的端口，要显式指定：

   ```bash
   ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173 make run
   ```

   说明：这个变量同时作用于 **REST 的 CORS** 和 **WS 的 `CheckOrigin`**。
   非浏览器客户端（没有 `Origin` 头，例如 Node 脚本）会被放行，所以 `web/test/e2e.mjs` 不需要额外配置。

3. 起静态服务器（`python3 -m http.server 5173 --directory web`），访问
   <http://localhost:5173/>，用真后端注册/登录即可。

**不想开 CORS 也可以同源反代**：让 Go 服务同时托管前端静态文件（把 `web/` 挂到某个路径），
或者用 nginx 把 `/api`、`/api/v1/ws` 反代到 8080 —— 此时前后端同源，不需要 `ALLOWED_ORIGINS`。

联调时打开 `CR.config.LOG = true` 能在控制台看到每一帧的收发内容，排查契约问题很快。

### 后端契约要点（已逐条对齐）

- REST 基地址 `${API_BASE}/api/v1`，除注册/登录外都带 `Authorization: Bearer <jwt>`。
- WS 地址 `${WS_BASE}/api/v1/ws?token=<jwt>` —— 浏览器不能自定义 WS 握手头，token 只能走 query。
- `seq` 形如 `"1730000000123-0"`，**当字符串处理**；排序时先比时间戳再比序号（见 `store.js` 的 `compareSeq`）。
- REST 历史消息**没有** `client_msg_id`，WS 下行的 `message` **有**（用于把乐观上屏的消息对上号）。
- `ts` 是 **Unix 秒**（不是毫秒）。

---

## 4. mock 模式能演示什么

`MOCK = true` 时 `api.js` / `ws.js` 的对外函数全部转发给 `js/mock.js`，接口形状与真后端一致。
预置 2 个房间（`r1` 大客厅 / `r2` 技术交流）、3 个用户、若干历史消息：

| 账号 | 密码 |
| --- | --- |
| `alice` | `alice123` |
| `bob` | `bob12345` |
| `bot` | `bot12345` |

可以演示的场景：

- **注册 / 登录 / 退出**，token 存 `localStorage`，刷新页面自动恢复会话；
- **收发消息**（乐观上屏"发送中" → ack 后"已发送" → 失败可点击重试）；
- **跨窗口互发**：开两个浏览器窗口，各登一个账号、进同一个房间，消息实时互通
  （用 `BroadcastChannel`，不支持时退化为 `localStorage` + `storage` 事件）；
- **断线重连与补拉**：点左栏底部「模拟断线（验证重连 + 补拉）」，会看到黄色横幅
  "连接已断开，正在重连（第 n 次）"，重连成功后悔自动带 `last_seq` 重新 `join`，
  服务端 `sync` 把断线期间的消息补齐且不重复；
- **未读角标**：点「演示：其它房间来消息」，别的房间会来一条消息，房间列表出现红色角标，
  切过去自动清零；
- **在线成员 / 人数实时同步**：机器人 2.5s 后加入房间、6s 后发言，右栏成员列表实时增减，
  左栏那一行的人数（`N 人`）会跟着一起变——不需要刷新页面；
  关掉其中一个窗口时，另一个窗口也会立刻把这个人从名单里去掉
  （mock 在 `beforeunload`/`pagehide` 抢着广播一次 leave，对齐真后端"读泵发现断线"的行为）；
- **分页**：`r1` 预置 90 条历史，而 join 时的 `sync` 最多补 60 条（mock 的 `SYNC_LIMIT`，
  对齐后端 `chat.SyncLimit`=200 的语义），所以更早的那 30 条只能靠滚到顶部翻页取，
  且加载后滚动位置不跳。

> 未读数在**真实后端**下无法用单窗口演示：后端是"一条连接只属于一个房间"（`join` 会把你
> 移出旧房间），所以非当前房间的消息根本不会推给你。这是契约差异，不是前端 bug。

> mock 的"服务端"和页面同生共死，所以关窗口时的离线通知是**尽力而为**（`BroadcastChannel`
> 的消息不保证在 unload 期间送达）。真后端没这个问题：连接一断，Hub 当场就摘 presence 并广播。

---

## 5. 验收自查结果（guide §8.2 六条，逐条确认）

自动化测试跑法（仓库根目录，只需要 Node ≥ 18，无需 `npm install`）：

```bash
make webtest        # 59 个用例：状态/契约/结构/连接重连/DOM 交互（全走 mock）
make web-e2e        # 14 步：接到真实 Go 后端跑一遍（需先 make up && make run）
```

| # | 验收项 | 结果 | 依据 |
| --- | --- | --- | --- |
| 1 | 双击 `index.html` 或静态服务器启动，无控制台报错直接运行 | ⚠️ 大部分自动化 | `structure.test.mjs` 保证：非 ES Module、脚本顺序正确、引用文件都存在、语法可解析、`file://` 自动 mock；`dom.test.mjs` 用 DOM 垫片加载**真实的 index.html 和全部脚本**，跑通"启动 → 登录 → 渲染 → 发消息 → 切房间 → 登出"并断言全程无 `console.error`。**视觉效果与真实浏览器行为仍需人眼过一遍**（见下方手工清单） |
| 2 | 双窗口 mock 互发消息正常，无重复渲染 | ✅ | `ws.test.mjs`「两个窗口互发」（mock 进程内双窗口 + 总线）与 `e2e.mjs`「两个连接互发消息」（真后端）都断言了 `seq` 唯一 |
| 3 | 断网恢复后自动重连，消息不丢不重（last_seq 补拉生效） | ✅ | `ws.test.mjs`「断线重连」断言重连后的 `join` 帧里 `last_seq` 等于断线前本地最大 seq，且补齐后无重复；`e2e.mjs` 用真后端真实断线复现 |
| 4 | 快速连发 10 条全部送达且各只出现一次 | ✅ | `ws.test.mjs`「连续快速发 10 条」：10 条乐观消息全部被 ack 收编，最终恰好 10 条、`seq` 无重复；真后端另测了同 `client_msg_id` 重发的幂等性 |
| 5 | 收到 Close 4001 时回登录视图且不再重连 | ✅ | `ws.test.mjs`「Close 4001：不重连，回调 unauthorized」断言 80ms 内没有新建连接；真实后端握手阶段返回 HTTP 401（浏览器只给 1006），`e2e.mjs` 验证了 REST 探针能识别并停止重连 |
| 6 | 非 mock 模式下请求路径、字段名与契约一字不差 | ✅ | `contract.test.mjs` 12 个用例逐条核对 method + 完整 URL（含 query 顺序与编码）+ 请求头 + body；`e2e.mjs` 再对真后端核一遍响应字段、`ts` 单位、历史倒序 |

### 第 1 条需要人眼确认的清单（浏览器手工过一次，约 2 分钟）

1. 双击 `web/index.html`，F12 → Console 应为空；页面显示登录卡片，底部提示"当前是 mock 模式"。
2. 随便输一个用户名 + 6 位密码 → 「注册并登录」→ 进入三栏聊天界面。
3. 左栏应该有 2 个房间且 `r1 大客厅` 高亮，中栏有历史消息且已滚到底部。
4. 发一条消息：先出现灰色"发送中…"，随后变成"已发送"。
5. 滚到中栏顶部：加载更早一页，**滚动位置不跳**；窗口拉窄到 768px 以下：
   左右栏变成抽屉，顶栏的 ☰ / 👥 按钮可开合，自己发的消息靠右主色、他人靠左灰色。
6. 打开第二个窗口登 `bob`，进同一个房间，两边互发；控制台仍然干净。

---

## 6. 测试说明

`test/` 下没有第三方依赖，用 Node 自带的 `node:test` + `node:vm`：

| 文件 | 覆盖内容 |
| --- | --- |
| `harness.mjs` | 小工具：在 Node 里用 `vm` 造一个假浏览器（window / localStorage / location / fetch / WebSocket）、假跨窗口总线、可编程的 WebSocket 替身、`waitFor` |
| `dom.mjs` | DOM 垫片：正则解析真实 `index.html` 建元素树，支持 `createElement/appendChild/classList/querySelector(All)/closest` 与冒泡式事件派发 |
| `store.test.mjs` | 可靠性逻辑：`seq` 去重与比较、乐观消息三态、ack 超时重试、`sync` 合并、未读数、会话持久化、配置默认值 |
| `contract.test.mjs` | REST 契约：路径、query、请求头、body、错误码映射、401 的两种语义（登录失败 vs 登录态失效） |
| `ws.test.mjs` | 连接与重连：mock 双窗口互发、10 条快速发送、断线重连 + `last_seq` 补拉、4001、握手 401 探针、退避序列与抖动、typing、4002 错误帧 |
| `dom.test.mjs` | UI 层：启动无报错、登录后房间/历史/成员渲染、乐观消息（含"未连接→发送失败→重连后点重试只出现一条"）、切房间与未读角标清零、左栏人数与右栏成员实时一致、断线横幅文案、退出登录清会话 |
| `structure.test.mjs` | 工程约束：文件齐全、`fetch` 只在 `api.js`、`new WebSocket` 只在 `ws.js`、无 ES Module / 框架 / 打包产物、脚本顺序、JS 用到的每个元素 id 都存在于 `index.html` |
| `e2e.mjs` | 真后端端到端（默认跳过，`CR_E2E=1` 开启）：REST 契约、WS 握手、双连接互发、幂等、断线补拉、成员离线实时同步、401 不重连 |

（共 59 个用例；`make webtest` 会把它们全部跑一遍，约 2 秒。）

```bash
# 单跑某个文件
node --test web/test/ws.test.mjs

# 真后端 e2e（先起 Redis 与服务）
CR_E2E=1 CR_API_BASE=http://localhost:8080 node web/test/e2e.mjs
```

---

## 7. 几个刻意的实现决定（与 guide 原文的差异都记在这里）

1. **不用 ES Module**：guide §8.2 同时要求"双击 `file://` 可运行"和"不使用打包器"，
   而 `file://` 下 `import` 会被拦。因此改成普通 `<script>` 顺序引入 + `window.CR` 全局命名空间，
   这一点 guide 也给了明确许可（"请将 `<script>` 改为普通顺序引入并共享全局命名空间，并在 README 说明差异"）。
2. **`MOCK` 默认值**：文件里写的是常量 `false`（对齐 guide），但 `file://` 下自动视为 `true`，
   否则"双击打开无控制台报错"这条验收做不到。`?mock=0/1` 可显式覆盖。
3. **invalid token 的握手失败**：guide 只描述了升级成功后的 `Close 4001`。但真实后端是
   **Upgrade 之前**就鉴权，token 失效时返回 HTTP 401，浏览器只会给出 `close code=1006`
   （和"网络不通"完全无法区分）。所以 `ws.js` 在"从未握手成功"时用一次 REST 探针
   （`GET /users/me`，由 `main.js` 用 `CR.ws.setAuthProbe` 注入，`fetch` 仍然只在 `api.js`）
   来区分两种失败：401 → 停止重连并回登录页；其它错误 → 继续退避重连。
4. **mock 的 ack 是异步的**（`MOCK_LATENCY_MIN/MAX`，默认 60~180ms）：真网络一定有往返延迟，
   异步才能看到"发送中 → 已发送"这条链路。mock 里 `dedup` 与写入仍是同步的，幂等性不受影响。
5. **历史消息是并集而不是替换**：REST 历史没有 `client_msg_id`，而 `sync` 可能先于历史到达、
   或者你之前翻过页；`store.setHistory` 用 `seq` 做并集合并，避免把已有的消息冲掉。
   切房间重新拉到历史时，还会用"同一个人 + 同样内容 + 时间差 ≤10s"把已经落库的乐观消息对账掉，防止重复渲染。
6. **未读数只能在 mock 演示**：见 §4 末尾的说明（后端一条连接只属于一个房间）。
7. **乐观消息与历史的对账**：REST 历史不带 `client_msg_id`（契约如此），而它可能**比 ack 先到**
   （历史请求发出后，服务端已经写入、ack 还在路上）。所以对账规则是"同一个人 + 内容相同 +
   时间差 ≤10s"，而且**不管这条乐观消息是否已 ack**：只要权威历史里已经有它，就把占位摘掉，
   否则会出现"历史一条 + 占位一条"的重复渲染。多条内容相同的消息按先后顺序一对一认领，
   不会把还未确认的那条也吃掉（`store.js` 的 `reconcilePending` 有对应单测）。
8. **join 未完成就发言**：服务端会回 `4002 join a room first`。这不该吓用户，所以 `main.js`
   把它当成"稍后重发"：消息退回"发送中"并进队列，收到 `joined` 后自动用**同一个
   `client_msg_id`** 补发（服务端按 id 幂等），期间不弹错误提示。真正发不出去（连接断开）
   才会显示"发送失败，点击重试"。

9. **在线人数以 presence 为准**：`GET /rooms` 返回的 `member_count` 是服务端**请求那一刻**按
   presence 算的快照（见 `internal/room/service.go`），拿到手就固定了；而右栏成员列表是 WS
   `presence` 驱动的。所以：
   - **当前房间**：`joined` 快照与 `presence` 事件是权威来源，会立刻回写到左栏那一行的人数
     （`store.syncRoomCount`），不需要重新请求 REST；
   - **其他房间**：拿不到 presence（一条连接只在一个房间），用 REST 快照，并在"重连成功"和
     "切回标签页"时各刷一次（`main.js`），不轮询；
   - 重新拉列表时，有 presence 数据的房间**不会被旧快照覆盖**（否则刚跳动的数字会倒回去）。
   后端侧 `internal/chat/hub.go` 也会在**任何连接退出路径**（断线、被踢、关服）立刻摘掉
   presence 并广播 `presence{leaves}`；`presenceTTL`(90s) 只作为"进程崩了来不及说再见"的兜底。
   这条是踩过的真坑：以前只有显式 `leave`/切房才广播，断线只能等 TTL 过期，
   用户看到的就是"有人退了名单不变，刷新才准"。

### 想"一个二进制部署前后端"（guide §8.4）

按 §8.4 用 `go:embed web/dist` 把静态产物塞进 Go 二进制。本前端没有构建步骤，
所以"产物"就是 `web/` 里的静态文件：

```bash
make web-dist     # 把 index.html / css / js 复制到 web/dist/（web/dist 已在 .gitignore 里）
```

然后再按 §8.4 的配方在 `cmd/server/` 里加 `//go:embed web/dist`（`//go:embed` 要求目录先存在，
所以顺序不能反）。