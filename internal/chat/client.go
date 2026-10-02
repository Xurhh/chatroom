package chat

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"time"

	"github.com/gorilla/websocket"
)

// NewClient 供 api 层在 Upgrade 成功后创建连接。
// 房间由客户端的 join 消息决定（guide 5.4），所以这里不带 roomID。
func NewClient(h *Hub, conn Conn, userID, name string) *Client {
	return newClient(h, conn, userID, name, "")
}

// ReadPump 独占读权：读超时 / pong 续命 / 解析 / 投递给 Hub（guide 1.4 / 1.5）。
func (c *Client) ReadPump() {
	defer c.Hub.clientsWG.Done() // 与 Hub.Join 里的 Add(2) 配对
	defer c.forget()             // 任何退出路径都交还 Hub 摘除，否则房间目录泄漏

	opts := c.Hub.opts
	c.Conn.SetReadLimit(opts.MaxMsgSize) // 防恶意大帧打爆内存（guide 1.5）
	_ = c.Conn.SetReadDeadline(time.Now().Add(opts.PongWait))
	c.Conn.SetPongHandler(func(string) error {
		// 收到 Pong 就给读超时"续命"——连接保活的全部逻辑就在这里
		return c.Conn.SetReadDeadline(time.Now().Add(opts.PongWait))
	})

	for {
		_, data, err := c.Conn.ReadMessage()
		if err != nil {
			ReadErrors.WithLabelValues(classifyReadErr(err)).Inc()
			return // 超时 / 对端关闭 / 网络错误，都从这里退出
		}
		MessagesReceived.Inc()

		if !c.limiter.Allow() { // 连接级限流（guide 2.7）
			c.sendError(CodeRateLimited, "rate limited", "")
			continue
		}
		c.dispatch(data)
	}
}

// WritePump 独占写权：唯一的 conn 写出点，顺带定时发 Ping（guide 1.4 / 1.5）。
func (c *Client) WritePump() {
	defer c.Hub.clientsWG.Done() // 与 Hub.Join 里的 Add(2) 配对
	opts := c.Hub.opts
	ticker := time.NewTicker(opts.PingPeriod)
	defer ticker.Stop()

	for {
		select {
		case <-c.done:
			return // 连接已被任意一方关闭
		case msg := <-c.Send:
			_ = c.Conn.SetWriteDeadline(time.Now().Add(opts.WriteWait))
			if err := c.Conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				c.shutdown(0, "")
				return
			}
			MessagesSent.Inc()
		case <-ticker.C:
			// 用 WriteControl 发 Ping：文档允许它与其它写并发（guide 1.4 的唯一例外）
			if err := c.Conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(opts.WriteWait)); err != nil {
				c.shutdown(0, "")
				return
			}
			c.touchPresence() // 心跳同时给 presence 续期（guide 4.3）
		}
	}
}

// touchPresence 异步续期在线状态。放异步是为了不让 Redis 抖动拖慢心跳/写出。
func (c *Client) touchPresence() {
	st := c.Hub.deps.Store
	room := c.Room()
	if st == nil || room == "" {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := st.PresenceJoin(ctx, room, c.UserID, c.Name); err != nil {
			c.logf().Warn("presence refresh failed", "err", err, "room", room, "uid", c.UserID)
		}
	}()
}

// ---------- 下行辅助 ----------

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte(`{"type":"error","code":4500,"message":"marshal failed"}`)
	}
	return b
}

func (c *Client) sendEnv(env OutEnvelope) { c.trySend(mustJSON(env)) }

func (c *Client) sendError(code int, msg, ref string) {
	c.sendEnv(OutEnvelope{Type: "error", Code: code, Message: msg, Ref: ref})
}

func (c *Client) sendAck(room, clientMsgID, seq string, ts int64) {
	c.sendEnv(OutEnvelope{Type: "ack", Room: room, ClientMsgID: clientMsgID, Seq: seq, TS: ts})
}

// broadcast 把 envelope 送到房间：M1 走 Redis Pub/Sub（含其它 Pod），M0 只走本地 Hub。
//
// 这里是"尽力而为"：发送失败不回滚消息——消息已经在 Stream 里，
// 掉线/丢包的客户端重连后带 last_seq 补拉即可（guide 2.10 / 4.4）。
func (c *Client) broadcast(room string, payload []byte) {
	if st := c.Hub.deps.Store; st != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := st.Publish(ctx, room, payload); err != nil {
			c.logf().Warn("publish failed", "err", err, "room", room)
		}
		return
	}
	c.Hub.PublishLocal(room, payload)
}

// classifyReadErr 把读错误分类，供 ws_read_errors_total 打点（guide 2.9）。
func classifyReadErr(err error) string {
	var netErr net.Error
	switch {
	case errors.As(err, &netErr) && netErr.Timeout():
		return "timeout"
	case websocket.IsCloseError(err,
		websocket.CloseNormalClosure, websocket.CloseGoingAway,
		websocket.CloseAbnormalClosure, websocket.CloseNoStatusReceived):
		return "close"
	default:
		return "bad_frame"
	}
}
