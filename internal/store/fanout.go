package store

import (
	"context"
	"sync"

	"github.com/redis/go-redis/v9"

	"chatroom/internal/chat"
)

// Fanout 是 chat.Subscriber 的 Redis Pub/Sub 实现（guide 4.4）。
//
// 目前用 PSUBSCRIBE chat:{env}:room:*:events 常驻订阅（guide 4.4 提到的"热圈"方案）：
// 实现最简单，也不会踩到 go-redis 动态退订时 Channel() 生命周期的边界问题；
// 代价是本 Pod 会收到所有房间的广播流量。
//
// TODO(M2): 房间多、带宽成为瓶颈时，改成按 Hub 的 RoomEvent 动态 SUBSCRIBE / UNSUBSCRIBE，
// 那时 Subscribe / Unsubscribe 两个方法才真正生效。
type Fanout struct {
	pubsub *redis.PubSub
	keys   *Keys

	once sync.Once
	ch   chan chat.Event
}

// NewFanout 建立常驻模式订阅。
func (s *Store) NewFanout(ctx context.Context) *Fanout {
	return &Fanout{
		pubsub: s.rdb.PSubscribe(ctx, s.keys.EventsPattern()),
		keys:   s.keys,
	}
}

// Subscribe 在常驻 pattern 订阅下是空操作（保留给动态订阅实现）。
func (f *Fanout) Subscribe(context.Context, ...string) error { return nil }

// Unsubscribe 在常驻 pattern 订阅下是空操作（保留给动态订阅实现）。
func (f *Fanout) Unsubscribe(context.Context, ...string) error { return nil }

// Channel 返回已解析出房间号的广播流；多次调用返回同一个 channel。
func (f *Fanout) Channel() <-chan chat.Event {
	f.once.Do(func() {
		f.ch = make(chan chat.Event, 256)
		go func() {
			defer close(f.ch)
			for msg := range f.pubsub.Channel() {
				room, ok := f.keys.RoomFromChannel(msg.Channel)
				if !ok {
					continue // 不是本前缀的频道（多环境共用 Redis 时可能出现）
				}
				select {
				case f.ch <- chat.Event{RoomID: room, Payload: []byte(msg.Payload)}:
				default: // 本地扇出跟不上：丢弃，客户端靠 last_seq 补拉
				}
			}
		}()
	})
	return f.ch
}

// Close 关闭订阅（RunFanout 退出时调用）。
func (f *Fanout) Close() error { return f.pubsub.Close() }
