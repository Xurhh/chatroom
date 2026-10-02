package api_test

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"chatroom/internal/api"
	"chatroom/internal/authn"
	"chatroom/internal/chat"
	"chatroom/internal/config"
	"chatroom/internal/room"
	"chatroom/internal/store"
)

// testLogger 在测试里只输出 warn 以上，避免刷屏。
func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
}

// TestWSM1WithRedis 是 M1 的端到端验收：Redis Stream 权威记录 + dedup 幂等 +
// Pub/Sub 扇出 + REST 历史，全链路走一遍。
//
//	REDIS_TEST_ADDR=localhost:6379 go test ./internal/api/ -run M1 -v
func TestWSM1WithRedis(t *testing.T) {
	addr := os.Getenv("REDIS_TEST_ADDR")
	if addr == "" {
		t.Skip("set REDIS_TEST_ADDR=host:port to run the M1 end-to-end test")
	}
	logger := testLogger()

	rdb := redis.NewClient(&redis.Options{Addr: addr})
	t.Cleanup(func() { _ = rdb.Close() })

	pingCtx, cancelPing := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelPing()
	if err := rdb.Ping(pingCtx).Err(); err != nil {
		t.Fatalf("redis ping: %v", err)
	}

	keys := store.NewKeys("test-e2e")
	st := store.New(rdb, keys, "e2e-node")

	// M1：Hub 接真实存储；本地投递靠"PUBLISH → 订阅 → 本地扇出"
	hub := chat.NewHub(chat.Deps{Store: st, Logger: logger})
	hub.Start()
	fanoutCtx, stopFanout := context.WithCancel(context.Background())
	go chat.RunFanout(fanoutCtx, hub, st.NewFanout(fanoutCtx), logger)
	t.Cleanup(func() {
		stopFanout()
		hub.Close()
		hub.Wait()
	})

	roomID := "e2e-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	clientMsgID := "cmid-" + roomID
	t.Cleanup(func() {
		cleanup := context.Background()
		_ = rdb.Del(cleanup, keys.Msgs(roomID), keys.Presence(roomID),
			keys.Meta(roomID), keys.Dedup(roomID, clientMsgID)).Err()
		_ = rdb.ZRem(cleanup, keys.RoomsIndex(), roomID).Err()
	})

	cfg := config.Load()
	cfg.AllowedOrigins = []string{"http://localhost:5173"}
	auth := authn.New("test-secret", time.Hour)
	srv := httptest.NewServer(api.NewRouter(api.RouterDeps{
		Cfg:      cfg,
		Auth:     auth,
		Handlers: api.NewHandlers(auth, st, room.NewService(st, logger), logger),
		Hub:      hub,
		Logger:   logger,
	}))
	t.Cleanup(srv.Close)

	tokenA, _, err := auth.Issue("u1", "bob")
	if err != nil {
		t.Fatal(err)
	}
	tokenB, _, err := auth.Issue("u2", "alice")
	if err != nil {
		t.Fatal(err)
	}
	a := dialWS(t, srv, tokenA)
	b := dialWS(t, srv, tokenB)

	if err := a.WriteJSON(map[string]any{"type": "join", "room": roomID, "last_seq": ""}); err != nil {
		t.Fatal(err)
	}
	waitWS(t, a, "joined", 5*time.Second)
	if err := b.WriteJSON(map[string]any{"type": "join", "room": roomID, "last_seq": ""}); err != nil {
		t.Fatal(err)
	}
	waitWS(t, b, "joined", 5*time.Second)

	// 发言：发言者拿 ack，对方拿 message；seq 来自 Redis Stream ID
	if err := a.WriteJSON(map[string]any{
		"type": "chat", "room": roomID, "client_msg_id": clientMsgID, "content": "hi from M1",
	}); err != nil {
		t.Fatal(err)
	}
	ack := waitWS(t, a, "ack", 5*time.Second)
	seq, _ := ack["seq"].(string)
	if seq == "" {
		t.Fatalf("ack has no seq: %v", ack)
	}
	msg := waitWS(t, b, "message", 5*time.Second)
	if msg["content"] != "hi from M1" || msg["seq"] != seq {
		t.Fatalf("message = %v, want seq %q", msg, seq)
	}

	// 重发同一个 client_msg_id：幂等，seq 不变
	if err := a.WriteJSON(map[string]any{
		"type": "chat", "room": roomID, "client_msg_id": clientMsgID, "content": "hi from M1",
	}); err != nil {
		t.Fatal(err)
	}
	dup := waitWS(t, a, "ack", 5*time.Second)
	if dup["seq"] != seq {
		t.Fatalf("duplicate ack seq = %v, want %q", dup["seq"], seq)
	}

	// 历史：REST 读同一份 Stream，且倒序（新→旧）
	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/v1/rooms/"+roomID+"/messages?limit=10", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+tokenA)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("history status = %d", resp.StatusCode)
	}
	var body struct {
		Messages []struct {
			Seq     string `json:"seq"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Messages) != 1 {
		t.Fatalf("history = %+v, want exactly 1 message (幂等生效)", body.Messages)
	}
	if body.Messages[0].Seq != seq || body.Messages[0].Content != "hi from M1" {
		t.Fatalf("history message = %+v, want seq %q", body.Messages[0], seq)
	}
}
