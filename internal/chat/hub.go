package chat

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// Deps 是 Hub 的外部依赖，全部由 main 层注入（guide 0.4）。
type Deps struct {
	// Store 为空表示 M0 纯内存模式：不落库、不补拉、不跨 Pod 扇出，
	// 只在进程内广播（guide 0.2 M0）。
	Store  Backend
	Logger *slog.Logger
	Opts   Options
}

// RoomEvent 房间本地成员的变化，供扇出协程动态订阅/退订 Redis 频道（guide 4.4）。
type RoomEvent struct {
	RoomID string
	Joined bool // true = 本 Pod 出现了该房间的第一个连接
}

const (
	// presenceIOTimeout 单次离线清理的 Redis 超时（摘记录 + 广播各一次调用）。
	presenceIOTimeout = 3 * time.Second
	// presenceDrainTimeout 关停时最多等清理协程多久：超时就放弃（TTL 兜底），不能卡住发布。
	presenceDrainTimeout = 3 * time.Second
)

// presenceEvent 表示"某个连接离开了某个房间"，由 presence 协程异步处理：
// 摘掉 Redis 里的在线记录，并给同房间其他人广播 presence{leaves}。
//
// 为什么需要它：guide 4.3 的 presence 有 90s TTL 兜底，但 TTL 只适合"进程崩了来不及说再见"
// 这种极端情况。正常断线（对端关连接、读超时、被踢）时 Hub 当场就知道人走了，
// 如果什么都不做，同房间其他人右栏会挂着一个幽灵成员、房间列表人数也会多算，
// 一直等到 TTL 过期（用户视角就是"要刷新页面才准"）。
type presenceEvent struct {
	RoomID string
	UserID string
}

// Hub 是进程内的连接目录与扇出中心：所有房间状态只被 run goroutine 读写，
// 因此这块共享数据零锁（guide 2.2）。
type Hub struct {
	deps Deps
	opts Options
	log  *slog.Logger

	ctx    context.Context
	cancel context.CancelFunc

	register     chan *Client
	unregister   chan unregisterReq
	broadcast    chan *Broadcast
	switchRoom   chan *switchReq
	membersReq   chan *membersReq
	roomEvents   chan RoomEvent
	presenceCh   chan presenceEvent
	presenceDone chan struct{}

	rooms map[string]map[*Client]struct{}

	runWG     sync.WaitGroup // 等 run goroutine 退出
	clientsWG sync.WaitGroup // 等所有 client 的 2 个 pump 退出

	presenceOnce sync.Once // Close 只做一次关停收尾（重复 Close 不能重复关 channel）

	started atomic.Bool
	conns   atomic.Int64 // 当前连接数（过载保护 + 日志用）
	localN  atomic.Int64 // M0 伪 seq 计数
}

type unregisterReq struct {
	client    *Client
	closeCode int // 0 = 不发 Close 帧
	reason    string
}

type switchReq struct {
	client *Client
	room   string
	done   chan struct{}
}

type membersReq struct {
	roomID string
	resp   chan []User
}

// NewHub 构造 Hub。调用方随后必须 Start()，并且在此之前不要 Join。
func NewHub(deps Deps) *Hub {
	if deps.Logger == nil {
		deps.Logger = slog.New(slog.DiscardHandler)
	}
	deps.Opts = deps.Opts.withDefaults()
	ctx, cancel := context.WithCancel(context.Background())
	return &Hub{
		deps:         deps,
		opts:         deps.Opts,
		log:          deps.Logger,
		ctx:          ctx,
		cancel:       cancel,
		register:     make(chan *Client, deps.Opts.RegisterBuf),
		unregister:   make(chan unregisterReq, deps.Opts.UnregisterBuf),
		broadcast:    make(chan *Broadcast, deps.Opts.BroadcastBuf),
		switchRoom:   make(chan *switchReq, deps.Opts.SwitchBuf),
		membersReq:   make(chan *membersReq, deps.Opts.MembersBuf),
		roomEvents:   make(chan RoomEvent, deps.Opts.RoomEventBuf),
		presenceCh:   make(chan presenceEvent, deps.Opts.PresenceEventBuf),
		presenceDone: make(chan struct{}),
		rooms:        make(map[string]map[*Client]struct{}),
	}
}

// Start 启动唯一的 run goroutine。
//
// 与 guide 3.2 的差异：WaitGroup.Add(1) 必须在 go Run() 之前完成，
// 否则 Close 里的 runWG.Wait() 可能在 Add 之前返回，房间目录就被并发遍历了。
func (h *Hub) Start() {
	if !h.started.CompareAndSwap(false, true) {
		return
	}
	h.runWG.Add(1)
	go h.run()
	go h.runPresence()
}

// run 是唯一触碰 rooms 的 goroutine（guide 2.2）。
func (h *Hub) run() {
	defer h.runWG.Done()
	for {
		select {
		case <-h.ctx.Done():
			return
		case c := <-h.register:
			h.add(c)
		case req := <-h.unregister:
			h.remove(req)
		case b := <-h.broadcast:
			h.fanout(b)
		case req := <-h.switchRoom:
			h.applySwitch(req)
		case req := <-h.membersReq:
			req.resp <- h.snapshotMembers(req.roomID)
		}
	}
}

// Connections 返回当前连接数（guide 2.7 的过载保护阈值判断用它）。
func (h *Hub) Connections() int64 { return h.conns.Load() }

// Join 由 WS handler 调用：登记连接。队列满说明系统过载，直接拒绝新连接（guide 2.7）。
//
// clientsWG.Add 放在这里（而不是 Hub.add 里）是有意的：它必须在调用方启动两个
// pump goroutine 之前完成，这样 pump 里的 Done 永远不会先于 Add 执行
// （guide 3.2 把 Add 放在 Run 里，pump 可能在 Add 之前就跑起来了）。
func (h *Hub) Join(c *Client) bool {
	select {
	case <-h.ctx.Done():
		c.shutdown(websocket.CloseGoingAway, "server shutting down")
		return false
	default:
	}
	h.clientsWG.Add(2) // readPump + writePump
	select {
	case h.register <- c:
		return true
	default:
		h.clientsWG.Add(-2)
		c.logf().Warn("register queue full, rejecting connection", "uid", c.UserID)
		c.shutdown(websocket.CloseTryAgainLater, "overloaded")
		return false
	}
}

// SwitchRoom 把连接移动到一个房间，并等待 Hub 完成目录更新（join/leave 用）。
func (h *Hub) SwitchRoom(c *Client, room string) bool {
	req := &switchReq{client: c, room: room, done: make(chan struct{})}
	select {
	case h.switchRoom <- req:
	case <-h.ctx.Done():
		return false
	case <-time.After(2 * time.Second):
		return false
	}
	select {
	case <-req.done:
		return true
	case <-h.ctx.Done():
		return false
	case <-time.After(2 * time.Second):
		return false
	}
}

// LocalMembers 返回本 Pod 上某房间的在线用户快照（M0 的 joined 消息用它）。
func (h *Hub) LocalMembers(roomID string) []User {
	req := &membersReq{roomID: roomID, resp: make(chan []User, 1)}
	select {
	case h.membersReq <- req:
	case <-h.ctx.Done():
		return nil
	}
	select {
	case out := <-req.resp:
		return out
	case <-h.ctx.Done():
		return nil
	case <-time.After(2 * time.Second):
		return nil
	}
}

// PublishLocal 把已序列化的 envelope 投给本进程内该房间的所有连接（尽力而为）。
// M0 直接走它；M1 由扇出协程收到 Redis 消息后调用它（guide 4.4）。
func (h *Hub) PublishLocal(roomID string, payload []byte) {
	h.publish(roomID, nil, payload)
}

func (h *Hub) publish(roomID string, from *Client, payload []byte) {
	select {
	case h.broadcast <- &Broadcast{RoomID: roomID, From: from, Payload: payload}:
	default:
		BroadcastDropped.Inc() // 全局广播队列满：丢弃，靠客户端 last_seq 补拉兜底
		h.log.Warn("broadcast queue full, dropping payload", "room", roomID)
	}
}

// RoomEvents 暴露房间成员变化事件流（扇出协程消费）。
func (h *Hub) RoomEvents() <-chan RoomEvent { return h.roomEvents }

// ---------- 以下方法只在 run goroutine 内执行 ----------

func (h *Hub) add(c *Client) {
	room := c.Room()
	h.insert(c)
	h.conns.Add(1)
	Connections.Inc()
	if room != "" && len(h.rooms[room]) == 1 {
		h.emit(RoomEvent{RoomID: room, Joined: true})
	}
}

func (h *Hub) ensureRoom(room string) {
	if h.rooms[room] == nil {
		h.rooms[room] = make(map[*Client]struct{})
	}
}

// insert 把连接放进它当前房间的集合（调用方必须已在 run goroutine 内）。
func (h *Hub) insert(c *Client) {
	room := c.Room()
	h.ensureRoom(room)
	h.rooms[room][c] = struct{}{}
}

func (h *Hub) remove(req unregisterReq) {
	c := req.client
	if c.removed.Swap(true) {
		return // 幂等：踢人与 readPump 退出可能都在注销队列里
	}
	room := c.Room()
	if set := h.rooms[room]; set != nil {
		delete(set, c)
		if len(set) == 0 {
			delete(h.rooms, room)
			if room != "" {
				h.emit(RoomEvent{RoomID: room, Joined: false})
			}
		}
	}
	if room != "" {
		// 断线 / 被踢也要当场摘 presence 并通知同房间其他人（正常 leave 与切房
		// 已经在 handleLeave / handleJoin 里做过了，那两条路径不经过 remove）。
		h.emitPresence(presenceEvent{RoomID: room, UserID: c.UserID})
	}
	h.conns.Add(-1)
	Connections.Dec()
	if req.closeCode != 0 {
		h.log.Info("kicking client", "uid", c.UserID, "room", room, "code", req.closeCode, "reason", req.reason)
	}
	c.shutdown(req.closeCode, req.reason)
}

func (h *Hub) applySwitch(req *switchReq) {
	defer close(req.done)
	c, room := req.client, req.room
	old := c.Room()
	if old == room {
		return
	}
	if set := h.rooms[old]; set != nil {
		delete(set, c)
		if len(set) == 0 {
			delete(h.rooms, old)
			if old != "" {
				h.emit(RoomEvent{RoomID: old, Joined: false})
			}
		}
	}
	c.setRoom(room)
	h.insert(c)
	if room != "" && len(h.rooms[room]) == 1 {
		h.emit(RoomEvent{RoomID: room, Joined: true})
	}
}

// fanout 把一个广播单元扇出到房间内所有连接（guide 2.3 / 2.4）。
func (h *Hub) fanout(b *Broadcast) {
	start := time.Now()
	defer func() { BroadcastDuration.Observe(time.Since(start).Seconds()) }()

	for c := range h.rooms[b.RoomID] {
		if c == b.From {
			continue // 是否回显发言者自己看产品需求；本实现靠 client_msg_id 幂等，不回显
		}
		select {
		case c.Send <- b.Payload:
			c.drops.Store(0)
		default:
			if c.drops.Add(1) >= h.opts.DropKickAt {
				c.kickSlow() // 慢消费者三振出局，绝不阻塞扇出
			}
			BroadcastDropped.Inc()
		}
	}
}

// snapshotMembers 返回本 Pod 某房间的成员快照（只在 run goroutine 内调用）。
func (h *Hub) snapshotMembers(roomID string) []User {
	set := h.rooms[roomID]
	out := make([]User, 0, len(set))
	for c := range set {
		out = append(out, c.User())
	}
	return out
}

// emit 非阻塞地发布房间事件：run goroutine 绝不因扇出协程慢而卡住。
func (h *Hub) emit(ev RoomEvent) {
	select {
	case h.roomEvents <- ev:
	default:
		h.log.Warn("room event queue full, dropping", "room", ev.RoomID, "joined", ev.Joined)
	}
}

// emitPresence 非阻塞投递离线事件：run goroutine 绝不因为 presence 协程慢而卡住。
// 队列满就丢弃并记日志 —— 这条连接对应的房间目录已经摘干净了，
// 只是"通知"晚一点，最坏情况由 presence TTL 兜底（guide 4.3）。
func (h *Hub) emitPresence(ev presenceEvent) {
	select {
	case h.presenceCh <- ev:
	default:
		PresenceLeaveDropped.Inc()
		h.log.Warn("presence queue full, dropping leave", "room", ev.RoomID, "uid", ev.UserID)
	}
}

// runPresence 是 Hub 的离线清理协程（每个进程一个）：
// 串行处理"谁离开了哪个房间"，① 从 Redis presence 里摘掉，② 广播 presence{leaves}。
//
// 为什么不直接在 run goroutine 里做：那是唯一触碰房间目录的协程（guide 2.2），
// 在它里面做 Redis IO 会让所有连接的 join/leave/广播排队等这次 IO。
func (h *Hub) runPresence() {
	defer close(h.presenceDone)
	for ev := range h.presenceCh {
		start := time.Now()
		ctx, cancel := context.WithTimeout(context.Background(), presenceIOTimeout)
		if st := h.deps.Store; st != nil {
			if err := st.PresenceLeave(ctx, ev.RoomID, ev.UserID); err != nil {
				h.log.Warn("presence leave failed", "room", ev.RoomID, "uid", ev.UserID, "err", err)
			}
		}
		h.publishPresenceLeave(ctx, ev.RoomID, ev.UserID)
		cancel()
		PresenceLeaveDuration.Observe(time.Since(start).Seconds())
	}
}

// publishPresenceLeave 把"某人离开了"广播给同房间其他人。
// 有 Store 时走 Redis Pub/Sub（这样别的 Pod 上的成员也能收到），否则只投本进程。
func (h *Hub) publishPresenceLeave(ctx context.Context, room, userID string) {
	payload := mustJSON(OutEnvelope{Type: "presence", Room: room, Leaves: []string{userID}})
	if st := h.deps.Store; st != nil {
		if err := st.Publish(ctx, room, payload); err != nil {
			h.log.Warn("publish presence leave failed", "room", room, "uid", userID, "err", err)
		}
		return
	}
	h.PublishLocal(room, payload)
}

func (h *Hub) nextLocalSeq() string {
	return fmt.Sprintf("%d-%d", time.Now().UnixMilli(), h.localN.Add(1))
}

// ---------- 关停（guide 2.6） ----------

// Close 停 run → 冻结房间目录 → 逐个发 Close 帧关连接 → 等离线清理排空。
func (h *Hub) Close() {
	h.cancel()
	h.runWG.Wait() // run 已退出，rooms 不再变化，此后遍历是安全的
	h.presenceOnce.Do(func() {
		for _, set := range h.rooms {
			for c := range set {
				// 关服也要摘 presence：不然滚动发布期间，其他 Pod 上的成员会看到
				// 一批"已经下线但还在线"的幽灵，直到 presence TTL 过期。
				h.emitPresence(presenceEvent{RoomID: c.Room(), UserID: c.UserID})
				c.shutdown(websocket.CloseNormalClosure, "server shutting down")
			}
		}
		started := h.started.Load()
		close(h.presenceCh)
		if !started {
			return // 没 Start 过就没有清理协程，别白等（测试里会这样用）
		}
		// 有界等待：清理是"尽力而为"，不能让关停无限期卡在 Redis 上（TTL 仍是兜底）。
		select {
		case <-h.presenceDone:
		case <-time.After(presenceDrainTimeout):
			h.log.Warn("presence cleanup did not finish before shutdown")
		}
	})
}

// Wait 等所有 client 的 pump goroutine 退出（Close 之后调用）。
func (h *Hub) Wait() { h.clientsWG.Wait() }

func (c *Client) logf() *slog.Logger { return c.Hub.log }
