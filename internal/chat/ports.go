package chat

import "context"

// Record 是权威存储里的一条消息（扁平字段，对应 guide 4.2 的 Stream 字段）。
//
// 注意与 Message 的区别：Message 是对外协议（`from` 是嵌套对象），
// Record 是存储视图（UserID/Name 平铺）。store.Message 是本类型的别名。
type Record struct {
	Seq     string
	UserID  string
	Name    string
	Content string
	TS      int64
}

// ToMessage 转成对外协议模型。
func (r Record) ToMessage() Message {
	return Message{
		Seq:     r.Seq,
		From:    &User{ID: r.UserID, Name: r.Name},
		Content: r.Content,
		TS:      r.TS,
	}
}

// History 是权威消息记录（M1 由 Redis Stream 实现，guide 4.2）。
//
// 去重是"先占位、后写 seq"三步，允许中间态：
//  1. DedupClaim 占位：首见 true，重复 false 并带出上次记录的 seq（可能为空 = 原消息仍在写）；
//  2. 写成功 → DedupRecordSeq 把 seq 补进 key；
//  3. 写失败 → DedupRelease 释放占位，让客户端重试。
type History interface {
	Append(ctx context.Context, roomID string, m Record) (seq string, err error)
	Since(ctx context.Context, roomID, lastSeq string, limit int64) ([]Record, error)
	DedupClaim(ctx context.Context, roomID, clientMsgID string) (first bool, seq string, err error)
	DedupRecordSeq(ctx context.Context, roomID, clientMsgID, seq string) error
	DedupRelease(ctx context.Context, roomID, clientMsgID string) error
}

// Presence 是在线状态（guide 4.3）。
type Presence interface {
	PresenceJoin(ctx context.Context, roomID, userID, name string) error
	PresenceLeave(ctx context.Context, roomID, userID string) error
	PresenceMembers(ctx context.Context, roomID string) (map[string]string, error)
}

// Publisher 是跨 Pod 的尽力而为扇出（guide 4.4）。
type Publisher interface {
	Publish(ctx context.Context, roomID string, payload []byte) error
}

// Backend 是 chat 包对外部存储的全部依赖，由 main 层注入 store.Store。
//
// store 包反向依赖 chat（为了复用 Record / 实现本接口），
// 而 chat 永不 import store —— 依赖方向单一，不会成环。
type Backend interface {
	History
	Presence
	Publisher
}
