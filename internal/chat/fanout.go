package chat

import (
	"context"
	"log/slog"
)

// Event 是从订阅端收到的跨节点广播（房间号 + 已序列化的 envelope）。
type Event struct {
	RoomID  string
	Payload []byte
}

// Subscriber 是多节点扇出的订阅端，由 store.Fanout 实现。
//
// 把它定义成接口，是为了让 chat 包不依赖 go-redis 的具体类型，
// 同时单测可以注入假订阅端（guide 4.4 / 9.1）。
type Subscriber interface {
	Subscribe(ctx context.Context, roomIDs ...string) error
	Unsubscribe(ctx context.Context, roomIDs ...string) error
	Channel() <-chan Event
	Close() error
}

// RunFanout 每个 Pod 一个：把订阅到的房间广播投给本地 Hub（guide 4.4）。
//
// 可靠性语义：Pub/Sub 是"尽力而为"，这里丢掉的广播不影响正确性，
// 因为权威记录在 Stream 里，客户端重连时带 last_seq 就能补回来（guide 2.10）。
func RunFanout(ctx context.Context, h *Hub, sub Subscriber, logger *slog.Logger) {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	defer func() { _ = sub.Close() }()

	roomEvents := h.RoomEvents()
	ch := sub.Channel()
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-roomEvents:
			if !ok {
				return
			}
			// 第一个本地成员进入房间时订阅、最后一个离开时退订。
			// TODO(M2): 换成按房间动态订阅后，这里就是真正生效的订阅管理。
			var err error
			if ev.Joined {
				err = sub.Subscribe(ctx, ev.RoomID)
			} else {
				err = sub.Unsubscribe(ctx, ev.RoomID)
			}
			if err != nil {
				logger.Warn("fanout subscription change failed", "room", ev.RoomID, "joined", ev.Joined, "err", err)
			}
		case m, ok := <-ch:
			if !ok {
				logger.Warn("fanout channel closed, stopping")
				return
			}
			h.PublishLocal(m.RoomID, m.Payload)
		}
	}
}
