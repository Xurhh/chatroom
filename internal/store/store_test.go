package store

import (
	"context"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// TestKeyLayout 固定 Redis key 布局（guide 4.1）：改 key 等于改数据契约。
func TestKeyLayout(t *testing.T) {
	k := NewKeys("prod")
	cases := map[string]string{
		k.Msgs("r1"):        "chat:prod:room:r1:msgs",
		k.Presence("r1"):    "chat:prod:room:r1:presence",
		k.Meta("r1"):        "chat:prod:room:r1:meta",
		k.Events("r1"):      "chat:prod:room:r1:events",
		k.EventsPattern():   "chat:prod:room:*:events",
		k.Dedup("r1", "m1"): "chat:prod:dedup:r1:m1",
		k.RoomsIndex():      "chat:prod:rooms",
		k.RoomSeq():         "chat:prod:room:seq",
	}
	for got, want := range cases {
		if got != want {
			t.Errorf("key = %q, want %q", got, want)
		}
	}
}

func TestRoomFromChannel(t *testing.T) {
	k := NewKeys("prod")
	cases := []struct {
		channel string
		want    string
		ok      bool
	}{
		{"chat:prod:room:r1:events", "r1", true},
		{"chat:prod:room:lobby:events", "lobby", true},
		{"chat:dev:room:r1:events", "", false},   // 别的环境
		{"chat:prod:room::events", "", false},    // 空房间号
		{"chat:prod:room:a:b:events", "", false}, // 房间号里不该有冒号
		{"chat:prod:dedup:r1:m1", "", false},     // 不是扇出频道
	}
	for _, c := range cases {
		got, ok := k.RoomFromChannel(c.channel)
		if got != c.want || ok != c.ok {
			t.Errorf("RoomFromChannel(%q) = (%q, %v), want (%q, %v)", c.channel, got, ok, c.want, c.ok)
		}
	}
}

// TestStoreIntegration 需要真实 Redis（CI 里用 service container 起一个）：
//
//	REDIS_TEST_ADDR=localhost:6379 go test ./internal/store/ -run Integration -v
func TestStoreIntegration(t *testing.T) {
	addr := os.Getenv("REDIS_TEST_ADDR")
	if addr == "" {
		t.Skip("set REDIS_TEST_ADDR=host:port to run Redis integration tests")
	}
	rdb := redis.NewClient(&redis.Options{Addr: addr})
	defer func() { _ = rdb.Close() }()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		t.Fatalf("redis ping: %v", err)
	}

	keys := NewKeys("test")
	s := New(rdb, keys, "test-node")
	room := "it-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	defer func() {
		cleanup := context.Background()
		_ = rdb.Del(cleanup, keys.Msgs(room), keys.Presence(room)).Err()
	}()

	// ---- Stream：append → since ----
	seq1, err := s.Append(ctx, room, Message{UserID: "u1", Name: "bob", Content: "hello", TS: time.Now().Unix()})
	if err != nil {
		t.Fatalf("append: %v", err)
	}
	if seq1 == "" {
		t.Fatal("append returned empty seq")
	}
	got, err := s.Since(ctx, room, "", 10)
	if err != nil {
		t.Fatalf("since: %v", err)
	}
	if len(got) != 1 || got[0].Content != "hello" || got[0].Seq != seq1 {
		t.Fatalf("since = %+v", got)
	}

	// ---- 幂等：占位 → 回填 → 重复拿到同一个 seq ----
	first, _, err := s.DedupClaim(ctx, room, "c1")
	if err != nil || !first {
		t.Fatalf("first claim = %v, %v", first, err)
	}
	if err := s.DedupRecordSeq(ctx, room, "c1", seq1); err != nil {
		t.Fatalf("record seq: %v", err)
	}
	first, dupSeq, err := s.DedupClaim(ctx, room, "c1")
	if err != nil || first || dupSeq != seq1 {
		t.Fatalf("duplicate claim = (%v, %q, %v), want (false, %q)", first, dupSeq, err, seq1)
	}
	if err := s.DedupRelease(ctx, room, "c1"); err != nil {
		t.Fatalf("release: %v", err)
	}
	if first, _, _ := s.DedupClaim(ctx, room, "c1"); !first {
		t.Fatal("claim after release should succeed")
	}

	// ---- presence：join → members → leave ----
	if err := s.PresenceJoin(ctx, room, "u1", "bob"); err != nil {
		t.Fatalf("presence join: %v", err)
	}
	members, err := s.PresenceMembers(ctx, room)
	if err != nil {
		t.Fatalf("presence members: %v", err)
	}
	if members["u1"] != "bob" {
		t.Fatalf("members = %v", members)
	}
	count, err := s.PresenceCount(ctx, room)
	if err != nil || count != 1 {
		t.Fatalf("count = %d, %v", count, err)
	}
	if err := s.PresenceLeave(ctx, room, "u1"); err != nil {
		t.Fatalf("presence leave: %v", err)
	}
	if count, _ := s.PresenceCount(ctx, room); count != 0 {
		t.Fatalf("count after leave = %d", count)
	}

	// ---- 房间元数据 ----
	id, err := s.NextRoomID(ctx)
	if err != nil {
		t.Fatalf("next room id: %v", err)
	}
	meta := RoomMeta{ID: id, Name: "测试房间", OwnerID: "u1", CreatedAt: time.Now().Unix()}
	if err := s.SaveRoomMeta(ctx, meta); err != nil {
		t.Fatalf("save meta: %v", err)
	}
	read, err := s.GetRoomMeta(ctx, id)
	if err != nil || read.Name != meta.Name {
		t.Fatalf("get meta = %+v, %v", read, err)
	}
	if _, err := s.GetRoomMeta(ctx, "no-such-room"); err != ErrRoomNotFound {
		t.Fatalf("get missing meta err = %v, want ErrRoomNotFound", err)
	}
}
