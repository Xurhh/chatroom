package chat

import (
	"context"
	"testing"
	"time"
)

// TestHandleChatM1WritePath 验证写路径组合拳（guide 4.4 / 2.10）：
// 幂等占位 → XADD 拿 seq → PUBLISH → ack，并且重复消息不会二次落库。
func TestHandleChatM1WritePath(t *testing.T) {
	sub := newFakeSubscriber()
	be := newFakeBackend()
	be.fanout = sub // Publish 会回声给订阅端，模拟 Redis Pub/Sub
	hub := NewHub(Deps{Store: be})
	hub.Start()

	// M1 中本地投递也走"PUBLISH → 订阅 → 本地 Hub 扇出"这条路（guide 4.4），
	// 所以要把扇出协程一起跑起来。
	fanoutCtx, stopFanout := context.WithCancel(context.Background())
	go RunFanout(fanoutCtx, hub, sub, nil)
	defer func() {
		stopFanout()
		hub.Close()
		hub.Wait()
	}()

	conn := newFakeConn()
	c := newClient(hub, conn, "u1", "bob", "")
	if !hub.Join(c) {
		t.Fatal("join failed")
	}
	c.Start()

	c.dispatch([]byte(`{"type":"join","room":"r1","last_seq":""}`))
	waitEnvelope(t, conn, "joined", time.Second)

	c.dispatch([]byte(`{"type":"chat","room":"r1","client_msg_id":"m1","content":"hello"}`))

	ack := waitEnvelope(t, conn, "ack", time.Second)
	if ack["seq"] != "1-0" || ack["client_msg_id"] != "m1" {
		t.Fatalf("ack = %v", ack)
	}
	msg := waitEnvelope(t, conn, "message", time.Second)
	if msg["content"] != "hello" || msg["seq"] != "1-0" {
		t.Fatalf("message = %v", msg)
	}
	if got := countEnvelopes(conn, "message"); got != 1 {
		t.Fatalf("message count = %d, want 1", got)
	}
	waitFor(t, time.Second, func() bool { return be.appends() == 1 }, "exactly one append")
	waitFor(t, time.Second, func() bool {
		for _, ty := range be.publishedTypes() {
			if ty == "message" {
				return true
			}
		}
		return false
	}, "message published to redis")

	// 同一 client_msg_id 重发：幂等，seq 不变、不再落库（guide 2.10 的"不重"）
	c.dispatch([]byte(`{"type":"chat","room":"r1","client_msg_id":"m1","content":"hello"}`))
	waitFor(t, time.Second, func() bool { return countEnvelopes(conn, "ack") >= 2 }, "second ack")
	if got := countEnvelopes(conn, "ack"); got != 2 {
		t.Fatalf("ack count = %d, want 2", got)
	}
	if be.appends() != 1 {
		t.Fatalf("duplicate was appended again: %d", be.appends())
	}
}

// TestHandleChatAppendFailureReleasesDedup 落库失败必须释放幂等占位，否则客户端永远无法重试。
func TestHandleChatAppendFailureReleasesDedup(t *testing.T) {
	be := newFakeBackend()
	be.failAppend = true
	hub := NewHub(Deps{Store: be})
	hub.Start()
	defer func() { hub.Close(); hub.Wait() }()

	conn := newFakeConn()
	c := newClient(hub, conn, "u1", "bob", "r1")
	if !hub.Join(c) {
		t.Fatal("join failed")
	}
	c.Start()

	c.dispatch([]byte(`{"type":"chat","room":"r1","client_msg_id":"m1","content":"hello"}`))
	env := waitEnvelope(t, conn, "error", time.Second)
	if code, _ := env["code"].(float64); int(code) != CodeInternalError {
		t.Fatalf("error = %v", env)
	}

	be.mu.Lock()
	_, stillClaimed := be.claimed["m1"]
	be.mu.Unlock()
	if stillClaimed {
		t.Fatal("dedup placeholder was not released after append failure")
	}
}

// TestHandleChatWithoutJoin 未 join 就发言 → 4002（guide 5.5）。
func TestHandleChatWithoutJoin(t *testing.T) {
	be := newFakeBackend()
	hub := NewHub(Deps{Store: be})
	hub.Start()
	defer func() { hub.Close(); hub.Wait() }()

	conn := newFakeConn()
	c := newClient(hub, conn, "u1", "bob", "")
	if !hub.Join(c) {
		t.Fatal("join failed")
	}
	c.Start()

	c.dispatch([]byte(`{"type":"chat","client_msg_id":"m1","content":"hi"}`))
	env := waitEnvelope(t, conn, "error", time.Second)
	if code, _ := env["code"].(float64); int(code) != CodeNotJoined {
		t.Fatalf("error = %v, want code %d", env, CodeNotJoined)
	}
	if be.appends() != 0 {
		t.Fatal("message was appended without joining a room")
	}
}

// TestHandleChatM0InMemory 无存储（M0）时也能在进程内广播并回 ack。
func TestHandleChatM0InMemory(t *testing.T) {
	hub := NewHub(Deps{}) // Store 为 nil = M0 纯内存模式
	hub.Start()
	defer func() { hub.Close(); hub.Wait() }()

	ca, cb := newFakeConn(), newFakeConn()
	a := newClient(hub, ca, "u1", "bob", "")
	b := newClient(hub, cb, "u2", "alice", "")
	if !hub.Join(a) || !hub.Join(b) {
		t.Fatal("join failed")
	}
	a.Start()
	b.Start()

	a.dispatch([]byte(`{"type":"join","room":"r1","last_seq":""}`))
	b.dispatch([]byte(`{"type":"join","room":"r1","last_seq":""}`))
	waitEnvelope(t, ca, "joined", time.Second)
	waitEnvelope(t, cb, "joined", time.Second)

	a.dispatch([]byte(`{"type":"chat","room":"r1","client_msg_id":"m1","content":"hi"}`))

	ack := waitEnvelope(t, ca, "ack", time.Second)
	if ack["seq"] == "" || ack["seq"] == nil {
		t.Fatalf("M0 ack has no seq: %v", ack)
	}
	msg := waitEnvelope(t, cb, "message", time.Second)
	if msg["content"] != "hi" {
		t.Fatalf("peer did not receive message: %v", msg)
	}
}

// TestHandleJoinSyncsHistoryBeforeJoined 验证 join 会先补拉（sync）再回在线快照（joined）。
func TestHandleJoinSyncsHistory(t *testing.T) {
	be := newFakeBackend()
	be.since = []Record{
		{Seq: "1730000000100-0", UserID: "u2", Name: "alice", Content: "old", TS: 1730000000},
	}
	hub := NewHub(Deps{Store: be})
	hub.Start()
	defer func() { hub.Close(); hub.Wait() }()

	conn := newFakeConn()
	c := newClient(hub, conn, "u1", "bob", "")
	if !hub.Join(c) {
		t.Fatal("join failed")
	}
	c.Start()

	c.dispatch([]byte(`{"type":"join","room":"r1","last_seq":"1730000000099-0"}`))
	sync := waitEnvelope(t, conn, "sync", time.Second)
	if sync["last_seq"] != "1730000000100-0" {
		t.Fatalf("sync = %v", sync)
	}
	msgs, _ := sync["messages"].([]any)
	if len(msgs) != 1 {
		t.Fatalf("sync messages = %v", sync["messages"])
	}
	if first, _ := msgs[0].(map[string]any); first["content"] != "old" {
		t.Fatalf("sync message = %v", msgs[0])
	}
	waitEnvelope(t, conn, "joined", time.Second)
}
