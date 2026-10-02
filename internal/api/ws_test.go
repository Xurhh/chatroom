package api_test

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
	"go.uber.org/goleak"

	"chatroom/internal/api"
	"chatroom/internal/authn"
	"chatroom/internal/chat"
	"chatroom/internal/config"
	"chatroom/internal/room"
	"chatroom/internal/store"
)

func TestMain(m *testing.M) {
	goleak.VerifyTestMain(m)
}

// newTestServer 起一套与生产共用路由表的测试服务（guide 9.2）。
//
// Hub 不接存储 → 走 M0 纯内存模式，WS 全链路测试不需要 Redis。
func newTestServer(t *testing.T) (*httptest.Server, *authn.Service) {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))

	cfg := config.Load()
	cfg.AllowedOrigins = []string{"http://localhost:5173"}

	auth := authn.New("test-secret", time.Hour)

	hub := chat.NewHub(chat.Deps{Logger: logger})
	hub.Start()
	t.Cleanup(func() {
		hub.Close()
		hub.Wait()
	})

	// REST handler 需要一个 *store.Store；这里不会真的调用 Redis（地址故意不可达）。
	rdb := redis.NewClient(&redis.Options{Addr: "127.0.0.1:1"})
	t.Cleanup(func() { _ = rdb.Close() })
	st := store.New(rdb, store.NewKeys("test"), "test-node")
	handlers := api.NewHandlers(auth, st, room.NewService(st, logger), logger)

	srv := httptest.NewServer(api.NewRouter(api.RouterDeps{
		Cfg:      cfg,
		Auth:     auth,
		Handlers: handlers,
		Hub:      hub,
		Logger:   logger,
	}))
	t.Cleanup(srv.Close)

	return srv, auth
}

func wsURL(srv *httptest.Server, token string) string {
	u := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/v1/ws"
	if token != "" {
		u += "?token=" + token
	}
	return u
}

func dialWS(t *testing.T, srv *httptest.Server, token string) *websocket.Conn {
	t.Helper()
	conn, resp, err := websocket.DefaultDialer.Dial(wsURL(srv, token), nil)
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		t.Fatalf("dial failed: %v (status %d)", err, status)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

// waitWS 顺序读取，返回第一个指定 type 的 envelope（跳过 sync/presence 等）。
func waitWS(t *testing.T, conn *websocket.Conn, wantType string, timeout time.Duration) map[string]any {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		_ = conn.SetReadDeadline(deadline)
		_, raw, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("waiting for %s: %v", wantType, err)
		}
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatalf("server sent invalid json %q: %v", raw, err)
		}
		if m["type"] == wantType {
			return m
		}
	}
	t.Fatalf("timeout waiting for %s", wantType)
	return nil
}

// TestWSJoinChatBroadcast 覆盖 guide 5.6 的主链路：建连 → join → 发言 → ack/广播。
func TestWSJoinChatBroadcast(t *testing.T) {
	srv, auth := newTestServer(t)
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

	if err := a.WriteJSON(map[string]any{"type": "join", "room": "r1", "last_seq": ""}); err != nil {
		t.Fatal(err)
	}
	joinedA := waitWS(t, a, "joined", 3*time.Second)
	if joinedA["room"] != "r1" {
		t.Fatalf("joined = %v", joinedA)
	}

	if err := b.WriteJSON(map[string]any{"type": "join", "room": "r1", "last_seq": ""}); err != nil {
		t.Fatal(err)
	}
	if joinedB := waitWS(t, b, "joined", 3*time.Second); joinedB["room"] != "r1" {
		t.Fatalf("joined = %v", joinedB)
	}

	if err := a.WriteJSON(map[string]any{
		"type": "chat", "room": "r1", "client_msg_id": "m1", "content": "hi",
	}); err != nil {
		t.Fatal(err)
	}

	ack := waitWS(t, a, "ack", 3*time.Second)
	if ack["client_msg_id"] != "m1" {
		t.Fatalf("ack = %v", ack)
	}
	if seq, _ := ack["seq"].(string); seq == "" {
		t.Fatalf("ack seq missing: %v", ack)
	}

	msg := waitWS(t, b, "message", 3*time.Second)
	if msg["content"] != "hi" {
		t.Fatalf("message = %v", msg)
	}
}

// TestWSRequiresToken Upgrade 前鉴权失败必须返回 HTTP 401，而不是"连上再断"（guide 1.3）。
func TestWSRequiresToken(t *testing.T) {
	srv, _ := newTestServer(t)

	conn, resp, err := websocket.DefaultDialer.Dial(wsURL(srv, ""), nil)
	if err == nil {
		_ = conn.Close()
		t.Fatal("dial without token should fail")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		t.Fatalf("status = %d, want 401", status)
	}
}

// TestWSRejectsBadToken 过期/伪造 token 同样 401。
func TestWSRejectsBadToken(t *testing.T) {
	srv, _ := newTestServer(t)

	conn, resp, err := websocket.DefaultDialer.Dial(wsURL(srv, "not-a-jwt"), nil)
	if err == nil {
		_ = conn.Close()
		t.Fatal("dial with bad token should fail")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %v, want 401", resp)
	}
}

// TestHealthAndReadyz 探针语义：liveness 不查依赖，readiness 在 RDB 为 nil 时直接就绪。
func TestHealthAndReadyz(t *testing.T) {
	srv, _ := newTestServer(t)

	for _, path := range []string{"/healthz", "/readyz"} {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Errorf("%s = %d, want 200", path, resp.StatusCode)
		}
	}

	// /metrics 由 promhttp 提供
	resp, err := http.Get(srv.URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("/metrics = %d, want 200", resp.StatusCode)
	}
}

// TestCORS 白名单源会回带 CORS 头，预检直接 204。
func TestCORS(t *testing.T) {
	srv, _ := newTestServer(t)

	req, err := http.NewRequest(http.MethodOptions, srv.URL+"/api/v1/rooms", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", "http://localhost:5173")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("preflight = %d, want 204", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "http://localhost:5173" {
		t.Fatalf("allow-origin = %q", got)
	}
}

// TestRestProtected 未带 JWT 的 REST 请求返回 401（guide 5.1）。
func TestRestProtected(t *testing.T) {
	srv, _ := newTestServer(t)

	resp, err := http.Get(srv.URL + "/api/v1/rooms")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
	}
}
