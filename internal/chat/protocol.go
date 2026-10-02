// Package chat 协议模型与 WS envelope 定义（纯数据结构，无逻辑）。
package chat

// ---------- 公共 ----------

// User 是出现在消息里的轻量用户视图。
type User struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Message 是一条聊天消息（REST 历史与 WS 广播共用）。
// seq 是 Redis Stream ID（形如 "1730000000123-0"），必须按字符串处理。
type Message struct {
	Seq     string `json:"seq"`
	From    *User  `json:"from"`
	Content string `json:"content"`
	TS      int64  `json:"ts"` // Unix 秒
}

// ---------- C→S ----------

// InEnvelope 是客户端上行消息。公共字段 type 必填。
type InEnvelope struct {
	Type        string `json:"type"`                    // join | leave | chat | typing | ping
	Room        string `json:"room,omitempty"`          // 房间 ID
	LastSeq     string `json:"last_seq,omitempty"`      // join 时携带：本地已收到的最大 seq
	ClientMsgID string `json:"client_msg_id,omitempty"` // chat 幂等键（UUID）
	Content     string `json:"content,omitempty"`       // chat 文本
}

// ---------- S→C ----------

// OutEnvelope 是服务端下行消息。
type OutEnvelope struct {
	Type        string    `json:"type"` // joined | sync | message | ack | presence | typing | error | pong
	Room        string    `json:"room,omitempty"`
	Seq         string    `json:"seq,omitempty"`
	From        *User     `json:"from,omitempty"`
	Content     string    `json:"content,omitempty"`
	TS          int64     `json:"ts,omitempty"`
	ClientMsgID string    `json:"client_msg_id,omitempty"` // ack / error.ref
	Members     []User    `json:"members,omitempty"`       // joined 在线快照
	Messages    []Message `json:"messages,omitempty"`      // sync 补拉
	LastSeq     string    `json:"last_seq,omitempty"`
	Joins       []User    `json:"joins,omitempty"`   // presence
	Leaves      []string  `json:"leaves,omitempty"`  // presence：userID 数组
	Code        int       `json:"code,omitempty"`    // error
	Message     string    `json:"message,omitempty"` // error
	Ref         string    `json:"ref,omitempty"`     // error：触发的 client_msg_id
}

// WS 关闭码 / error code（见 guide 5.5）。
const (
	CodeUnauthorized  = 4001
	CodeNotJoined     = 4002
	CodeRateLimited   = 4003
	CodeSlowConsumer  = 4008
	CodeBadRequest    = 4400
	CodeInternalError = 4500
)
