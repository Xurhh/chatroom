package chat

import (
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/time/rate"
)

// Conn 是一条 WS 连接的最小接口，*websocket.Conn 天然满足。
//
// 抽成接口只有一个目的：单测可以注入假连接（guide 9.1），
// 从而在没有真实网络的情况下验证 Hub 扇出、背压踢人、读循环退出路径。
type Conn interface {
	ReadMessage() (messageType int, p []byte, err error)
	WriteMessage(messageType int, data []byte) error
	WriteControl(messageType int, data []byte, deadline time.Time) error
	SetReadLimit(limit int64)
	SetReadDeadline(t time.Time) error
	SetWriteDeadline(t time.Time) error
	SetPongHandler(h func(appData string) error)
	Close() error
}

// Broadcast 是预序列化后的广播单元：
// 一条消息 marshal 一次，房间内 N 个连接复用同一个 []byte（guide 2.4）。
type Broadcast struct {
	RoomID  string
	From    *Client // 可为 nil（系统消息 / 来自其它 Pod 的消息）
	Payload []byte  // 已 marshal 的 JSON envelope
}

// Client 一条 WS 连接。
//
// 并发纪律：
//   - Send 只由 Hub 的扇出投递，且 **永不 close**（见 trySend 注释）；
//   - 连接状态（room / closed / drops）用 atomic，因为 readPump 与 Hub goroutine 都会碰；
//   - 其余字段在构造后只读，无需加锁。
type Client struct {
	Hub  *Hub
	Conn Conn

	// Send 是本连接的下行队列，容量 Options.SendBuf。
	// 投递一律 select+default：宁可丢消息（靠 seq 补拉兜底），绝不阻塞扇出路径。
	Send chan []byte

	UserID string
	Name   string

	room      atomic.Pointer[string] // 当前房间；由 Hub goroutine 写入
	limiter   *rate.Limiter          // 每连接独立令牌桶（guide 2.7）
	done      chan struct{}
	closeOnce sync.Once
	closed    atomic.Bool
	forgotten atomic.Bool // 已向 Hub 提交注销（踢人 / readPump 退出只算一次）
	removed   atomic.Bool // Hub 侧已从房间目录摘除（remove 幂等）
	drops     atomic.Int32
}

// newClient 组装连接。room 可以为空，由客户端的 join 消息决定（guide 5.4）。
func newClient(h *Hub, conn Conn, userID, name, room string) *Client {
	c := &Client{
		Hub:     h,
		Conn:    conn,
		Send:    make(chan []byte, h.opts.SendBuf),
		UserID:  userID,
		Name:    name,
		limiter: rate.NewLimiter(rate.Limit(h.opts.RatePerSec), h.opts.RateBurst),
		done:    make(chan struct{}),
	}
	c.setRoom(room)
	return c
}

// Room 返回当前房间（空串 = 尚未 join）。
func (c *Client) Room() string {
	if p := c.room.Load(); p != nil {
		return *p
	}
	return ""
}

// setRoom 只应由 Hub 的 run goroutine 调用（它拥有房间目录）。
func (c *Client) setRoom(room string) {
	c.room.Store(&room)
}

// User 返回本连接的对外用户视图。
func (c *Client) User() User { return User{ID: c.UserID, Name: c.Name} }

// Start 顺序固定：先起写泵（独占写权），再起读泵（读泵退出会触发注销）。
func (c *Client) Start() {
	go c.WritePump()
	go c.ReadPump()
}

// trySend 非阻塞投递到本连接队列。返回 false 表示队列满被丢弃。
//
// 注意：Send 永远不被 close，所以这里不存在 "send on closed channel" 的 panic 风险
// （guide 3.2 用 close(c.Send) 通知 writePump，代价是任何持有 Client 的 goroutine
// 直接投递时都可能撞上 close → panic）。writePump 的退出信号统一走 done。
func (c *Client) trySend(payload []byte) bool {
	if c.closed.Load() {
		return false
	}
	select {
	case c.Send <- payload:
		return true
	default:
		BroadcastDropped.Inc()
		return false
	}
}

// shutdown 幂等关闭：可选地先发 Close 帧（WriteControl 可与其它写并发），再关连接。
// code == 0 表示对端已断（或系统关闭），不需要再发 Close 帧。
func (c *Client) shutdown(code int, text string) {
	c.closeOnce.Do(func() {
		if code != 0 {
			_ = c.Conn.WriteControl(websocket.CloseMessage,
				websocket.FormatCloseMessage(code, text), time.Now().Add(c.Hub.opts.WriteWait))
		}
		c.closed.Store(true)
		_ = c.Conn.Close()
		close(c.done)
	})
}

// kickSlow 把"慢消费者踢除"的决定交给 Hub 的注销队列（guide 2.3）。
// 只在 Hub goroutine 内调用，所以用非阻塞投递：队列忙就撤销标记，下次扇出再试。
func (c *Client) kickSlow() {
	if c.forgotten.Swap(true) {
		return
	}
	select {
	case c.Hub.unregister <- unregisterReq{client: c, closeCode: CodeSlowConsumer, reason: "slow consumer"}:
	default:
		c.forgotten.Store(false)
	}
}

// forget 断开时把连接交还 Hub 统一摘除（readPump 的 defer 调用）。
//
// 与 kickSlow 不同，这里允许短暂阻塞：注销必须成功，否则房间目录会泄漏。
// Hub 一旦停止（ctx 取消）就自己兜底关闭。
func (c *Client) forget() {
	if c.forgotten.Swap(true) {
		return // 已经被踢过，无需重复注销
	}
	select {
	case c.Hub.unregister <- unregisterReq{client: c}:
	case <-c.Hub.ctx.Done():
		c.shutdown(0, "")
	}
}
