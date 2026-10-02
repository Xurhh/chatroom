package chat

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

// TestHubFanout 验证"一条消息 marshal 一次、扇出到房间内每个连接"。
func TestHubFanout(t *testing.T) {
	hub := NewHub(Deps{Opts: Options{SendBuf: 8}})
	hub.Start()
	defer func() { hub.Close(); hub.Wait() }()

	ca, cb := newFakeConn(), newFakeConn()
	a := newClient(hub, ca, "u1", "bob", "r1")
	b := newClient(hub, cb, "u2", "alice", "r1")
	if !hub.Join(a) || !hub.Join(b) {
		t.Fatal("join failed")
	}
	a.Start()
	b.Start()
	waitFor(t, time.Second, func() bool { return hub.Connections() == 2 }, "two clients registered")

	const payload = `{"type":"message","content":"hi"}`
	hub.PublishLocal("r1", []byte(payload))

	waitFor(t, time.Second, func() bool {
		return len(ca.written()) == 1 && len(cb.written()) == 1
	}, "both room members received the payload")
	if got := string(ca.written()[0]); got != payload {
		t.Fatalf("payload = %s, want %s", got, payload)
	}
}

// TestHubBroadcastsPresenceLeaveOnDisconnect 验证"直接断线"也会当场摘 presence 并通知同房间的人。
//
// 这是回归测试：以前只有显式 leave / 切房才广播 presence{leaves}，
// 断线只能靠 presence TTL（90s）过期，用户视角就是"有人退出了但名单不变，刷新才准"。
func TestHubBroadcastsPresenceLeaveOnDisconnect(t *testing.T) {
	hub := NewHub(Deps{Opts: Options{SendBuf: 8}})
	hub.Start()
	defer func() { hub.Close(); hub.Wait() }()

	ca, cb := newFakeConn(), newFakeConn()
	a := newClient(hub, ca, "u1", "bob", "r1")
	b := newClient(hub, cb, "u2", "alice", "r1")
	if !hub.Join(a) || !hub.Join(b) {
		t.Fatal("join failed")
	}
	a.Start()
	b.Start()
	waitFor(t, time.Second, func() bool { return hub.Connections() == 2 }, "two clients registered")

	// 直接关连接 = 对端拔线：读泵读到错误 → forget → Hub 摘除 → 离线清理
	if err := ca.Close(); err != nil {
		t.Fatalf("close conn: %v", err)
	}
	waitFor(t, time.Second, func() bool { return hub.Connections() == 1 }, "client removed from hub")

	env := waitEnvelope(t, cb, "presence", time.Second)
	if got := fmt.Sprint(env["leaves"]); got != "[u1]" {
		t.Fatalf("presence leaves = %v, want [u1]", env["leaves"])
	}
	if got := fmt.Sprint(env["room"]); got != "r1" {
		t.Fatalf("presence room = %v, want r1", env["room"])
	}
	if n := countEnvelopes(cb, "presence"); n != 1 {
		t.Fatalf("presence 广播了 %d 次，重复通知会让前端成员列表抖动", n)
	}
	if got := hub.LocalMembers("r1"); len(got) != 1 || got[0].ID != "u2" {
		t.Fatalf("r1 本地成员 = %v, want 只剩 u2", got)
	}
}

// TestHubPresenceLeaveCleansStore 验证离线清理协程真的动了存储：摘 presence + 广播出去（跨 Pod 靠 Pub/Sub）。
func TestHubPresenceLeaveCleansStore(t *testing.T) {
	be := newFakeBackend()
	hub := NewHub(Deps{Store: be, Opts: Options{SendBuf: 8}})
	hub.Start()
	defer func() { hub.Close(); hub.Wait() }()

	conn := newFakeConn()
	c := newClient(hub, conn, "u1", "bob", "r1")
	if !hub.Join(c) {
		t.Fatal("join failed")
	}
	c.Start()
	waitFor(t, time.Second, func() bool { return hub.Connections() == 1 }, "client registered")

	if err := conn.Close(); err != nil {
		t.Fatalf("close conn: %v", err)
	}
	waitFor(t, time.Second, func() bool { return hub.Connections() == 0 }, "client removed from hub")

	waitFor(t, time.Second, func() bool { return len(be.presenceLeaves()) == 1 }, "PresenceLeave called")
	if got := be.presenceLeaves()[0]; got != "r1/u1" {
		t.Fatalf("PresenceLeave(%s), want r1/u1", got)
	}

	var found map[string]any
	waitFor(t, time.Second, func() bool {
		for _, b := range be.publishedPayloads() {
			var m map[string]any
			if json.Unmarshal(b, &m) != nil || m["type"] != "presence" {
				continue
			}
			found = m
			return true
		}
		return false
	}, "presence leave published to room (cross-pod)")
	if got := fmt.Sprint(found["leaves"]); got != "[u1]" {
		t.Fatalf("published leaves = %v, want [u1]", found["leaves"])
	}
}

// TestHubKicksSlowConsumer 验证背压：写不出去 + 连续丢弃 → 被 Hub 踢除并收到 Close 帧。
func TestHubKicksSlowConsumer(t *testing.T) {
	hub := NewHub(Deps{Opts: Options{SendBuf: 1, DropKickAt: 3}})
	hub.Start()
	defer func() { hub.Close(); hub.Wait() }()

	conn := newFakeConn()
	conn.blockWrites = true // 写泵卡死在第一个写操作上
	c := newClient(hub, conn, "u1", "bob", "r1")
	if !hub.Join(c) {
		t.Fatal("join failed")
	}
	c.Start()
	waitFor(t, time.Second, func() bool { return hub.Connections() == 1 }, "client registered")

	// 第 1 条被写泵取走（卡住），第 2 条填满队列，之后每条都丢弃 → 3 条即三振出局
	for i := 0; i < 8; i++ {
		hub.PublishLocal("r1", []byte(`{"type":"message"}`))
	}

	waitFor(t, 2*time.Second, func() bool { return hub.Connections() == 0 }, "slow consumer kicked")
	waitFor(t, time.Second, func() bool { return conn.closeFrames() > 0 }, "close frame sent to slow consumer")
}

// TestHubSwitchRoom 验证 join/leave 的房间目录变更，以及 LocalMembers 快照。
func TestHubSwitchRoom(t *testing.T) {
	hub := NewHub(Deps{})
	hub.Start()
	defer func() { hub.Close(); hub.Wait() }()

	conn := newFakeConn()
	c := newClient(hub, conn, "u1", "bob", "")
	if !hub.Join(c) {
		t.Fatal("join failed")
	}
	c.Start()

	waitFor(t, time.Second, func() bool { return hub.Connections() == 1 }, "client registered")
	if !hub.SwitchRoom(c, "r1") {
		t.Fatal("switch to r1 failed")
	}
	waitFor(t, time.Second, func() bool {
		m := hub.LocalMembers("r1")
		return len(m) == 1 && m[0].ID == "u1"
	}, "client visible in r1")

	if !hub.SwitchRoom(c, "") {
		t.Fatal("leave failed")
	}
	waitFor(t, time.Second, func() bool { return len(hub.LocalMembers("r1")) == 0 }, "client removed from r1")
}

// TestHubRoomEvents 验证"第一个本地成员进入 / 最后一个离开"会通知扇出协程。
func TestHubRoomEvents(t *testing.T) {
	hub := NewHub(Deps{})
	hub.Start()
	defer func() { hub.Close(); hub.Wait() }()

	conn := newFakeConn()
	c := newClient(hub, conn, "u1", "bob", "r1")
	if !hub.Join(c) {
		t.Fatal("join failed")
	}
	c.Start()

	select {
	case ev := <-hub.RoomEvents():
		if ev.RoomID != "r1" || !ev.Joined {
			t.Fatalf("first event = %+v, want r1 joined", ev)
		}
	case <-time.After(time.Second):
		t.Fatal("no room event for first member")
	}

	c.shutdown(0, "")
	select {
	case ev := <-hub.RoomEvents():
		if ev.RoomID != "r1" || ev.Joined {
			t.Fatalf("second event = %+v, want r1 emptied", ev)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no room event for last member leaving")
	}
}

// TestBroadcastEnvelopeShape 固定下行 message 的字段名，防止协议漂移（guide 5.4）。
func TestBroadcastEnvelopeShape(t *testing.T) {
	raw := mustJSON(OutEnvelope{
		Type: "message", Room: "r1", Seq: "1730000000123-0",
		From: &User{ID: "u1", Name: "bob"}, Content: "hello", TS: 1730000000,
		ClientMsgID: "m1",
	})
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("bad json: %v", err)
	}
	for _, key := range []string{"type", "room", "seq", "from", "content", "ts", "client_msg_id"} {
		if _, ok := m[key]; !ok {
			t.Errorf("envelope missing key %q: %s", key, raw)
		}
	}
	if seq, _ := m["seq"].(string); seq != "1730000000123-0" {
		t.Errorf("seq must stay a string, got %T(%v)", m["seq"], m["seq"])
	}
}
