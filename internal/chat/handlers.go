package chat

import (
	"context"
	"encoding/json"
	"time"
)

// dispatch 解析并分发一条上行消息（guide 5.4 的 C→S 类型表）。
func (c *Client) dispatch(data []byte) {
	var in InEnvelope
	if err := json.Unmarshal(data, &in); err != nil {
		c.sendError(CodeBadRequest, "bad json", "")
		return
	}
	switch in.Type {
	case "join":
		c.handleJoin(in)
	case "leave":
		c.handleLeave(in)
	case "chat":
		c.handleChat(in)
	case "typing":
		c.handleTyping(in)
	case "ping":
		c.sendEnv(OutEnvelope{Type: "pong"})
	default:
		c.sendError(CodeBadRequest, "unknown type", "")
	}
}

// handleJoin：订阅房间 + 补拉漏收 + 返回在线快照（guide 5.6）。
func (c *Client) handleJoin(in InEnvelope) {
	if in.Room == "" {
		c.sendError(CodeBadRequest, "room required", "")
		return
	}
	room := in.Room
	prev := c.Room()
	if !c.Hub.SwitchRoom(c, room) {
		c.sendError(CodeInternalError, "join failed, retry later", "")
		return
	}

	// ---- M0：纯内存，只回本地快照 ----
	st := c.Hub.deps.Store
	if st == nil {
		c.sendEnv(OutEnvelope{Type: "sync", Room: room, Messages: []Message{}, LastSeq: in.LastSeq})
		c.sendEnv(OutEnvelope{Type: "joined", Room: room, Members: c.Hub.LocalMembers(room)})
		c.broadcast(room, mustJSON(OutEnvelope{Type: "presence", Room: room, Joins: []User{c.User()}}))
		return
	}

	// ---- M1：presence + Stream 补拉 ----
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	if prev != "" && prev != room { // 换房：先清旧房间的在线态
		_ = st.PresenceLeave(ctx, prev, c.UserID)
		c.broadcast(prev, mustJSON(OutEnvelope{Type: "presence", Room: prev, Leaves: []string{c.UserID}}))
	}
	if err := st.PresenceJoin(ctx, room, c.UserID, c.Name); err != nil {
		c.logf().Warn("presence join failed", "err", err, "room", room, "uid", c.UserID)
	}

	// 1) 补拉 last_seq 之后的增量：同时兜住"断线漏收"和"背压丢弃"（guide 2.10）
	msgs := []Message{}
	lastSeq := in.LastSeq
	if recs, err := st.Since(ctx, room, in.LastSeq, c.Hub.opts.SyncLimit); err != nil {
		c.logf().Warn("sync failed", "err", err, "room", room, "from", in.LastSeq)
	} else {
		msgs = make([]Message, 0, len(recs))
		for _, r := range recs {
			msgs = append(msgs, r.ToMessage())
			lastSeq = r.Seq
		}
	}
	c.sendEnv(OutEnvelope{Type: "sync", Room: room, Messages: msgs, LastSeq: lastSeq})

	// 2) 在线快照（PresenceMembers 已做惰性过期过滤）
	members := []User{}
	if m, err := st.PresenceMembers(ctx, room); err != nil {
		c.logf().Warn("presence snapshot failed", "err", err, "room", room)
	} else {
		members = make([]User, 0, len(m))
		for uid, name := range m {
			members = append(members, User{ID: uid, Name: name})
		}
	}
	c.sendEnv(OutEnvelope{Type: "joined", Room: room, Members: members})

	// 3) 通知房间其他人（尽力而为；漏了靠离线的人 join 时重新拉 presence）
	c.broadcast(room, mustJSON(OutEnvelope{Type: "presence", Room: room, Joins: []User{c.User()}}))
}

// handleLeave：退出当前房间（M0/M1 都是"把连接移出房间目录"）。
func (c *Client) handleLeave(in InEnvelope) {
	room := c.Room()
	if room == "" {
		c.sendError(CodeNotJoined, "not in a room", "")
		return
	}
	if !c.Hub.SwitchRoom(c, "") {
		c.sendError(CodeInternalError, "leave failed, retry later", "")
		return
	}
	if st := c.Hub.deps.Store; st != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = st.PresenceLeave(ctx, room, c.UserID)
	}
	c.broadcast(room, mustJSON(OutEnvelope{Type: "presence", Room: room, Leaves: []string{c.UserID}}))
}

// handleChat 是写路径组合拳（guide 4.4 / 2.10）：
//
//	① SET NX 幂等占位 → ② XADD 拿 seq（权威）→ ③ PUBLISH 广播（尽力）→ ④ ack 给发言者
func (c *Client) handleChat(in InEnvelope) {
	room := c.Room()
	if room == "" || (in.Room != "" && in.Room != room) {
		c.sendError(CodeNotJoined, "join a room first", in.ClientMsgID) // guide 5.5 4002
		return
	}
	switch {
	case in.ClientMsgID == "":
		c.sendError(CodeBadRequest, "client_msg_id required", "")
		return
	case in.Content == "":
		c.sendError(CodeBadRequest, "content required", in.ClientMsgID)
		return
	case len(in.Content) > c.Hub.opts.MaxContent:
		c.sendError(CodeBadRequest, "content too long", in.ClientMsgID)
		return
	}

	ts := time.Now().Unix()
	st := c.Hub.deps.Store
	if st == nil {
		// M0 纯内存模式：没有权威存储，只能用本地伪 seq，重启即丢。
		// TODO(M1): 接入 Redis Stream 后本分支自动不再走到。
		c.finishChat(room, in, c.Hub.nextLocalSeq(), ts)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	// ① 幂等占位：重复消息直接回原 seq 的 ack，不重复落库、不重复广播（guide 2.10）
	first, oldSeq, err := st.DedupClaim(ctx, room, in.ClientMsgID)
	if err != nil {
		c.sendError(CodeInternalError, "storage unavailable", in.ClientMsgID)
		return
	}
	if !first {
		if oldSeq == "" {
			// 占位已建但 seq 尚未回填 = 上一条还在写。让客户端稍后重试（重发是幂等的）。
			c.sendError(CodeInternalError, "duplicate in flight, retry later", in.ClientMsgID)
			return
		}
		c.sendAck(room, in.ClientMsgID, oldSeq, ts)
		return
	}

	// ② 权威记录：Stream ID 天然单调且与存储强一致，直接当 seq
	seq, err := st.Append(ctx, room, Record{UserID: c.UserID, Name: c.Name, Content: in.Content, TS: ts})
	if err != nil {
		_ = st.DedupRelease(ctx, room, in.ClientMsgID) // 写失败必须释放占位才能重试
		c.sendError(CodeInternalError, "append failed", in.ClientMsgID)
		return
	}
	// ③ 回填 seq：同 id 的重发都能拿到同一个 seq
	if err := st.DedupRecordSeq(ctx, room, in.ClientMsgID, seq); err != nil {
		c.logf().Warn("record dedup seq failed", "err", err, "room", room)
	}

	// ④ 广播 + ack
	c.finishChat(room, in, seq, ts)
}

// finishChat 广播 message 并回 ack。
//
// message 里带 client_msg_id，是为了让前端把乐观上屏的消息与服务端消息对上号
// （guide 8.2 的"收到 message 时按 client_msg_id 幂等去重"）。
func (c *Client) finishChat(room string, in InEnvelope, seq string, ts int64) {
	from := c.User()
	c.broadcast(room, mustJSON(OutEnvelope{
		Type:        "message",
		Room:        room,
		Seq:         seq,
		From:        &from,
		Content:     in.Content,
		TS:          ts,
		ClientMsgID: in.ClientMsgID,
	}))
	c.sendAck(room, in.ClientMsgID, seq, ts)
}

// handleTyping：正在输入，纯转发、不落库（节流由前端负责，guide 8.2）。
func (c *Client) handleTyping(in InEnvelope) {
	room := c.Room()
	if room == "" || (in.Room != "" && in.Room != room) {
		c.sendError(CodeNotJoined, "join a room first", "")
		return
	}
	from := c.User()
	c.broadcast(room, mustJSON(OutEnvelope{Type: "typing", Room: room, From: &from}))
}
