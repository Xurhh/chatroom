package api

import (
	"context"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"

	"chatroom/internal/authn"
	"chatroom/internal/chat"
	"chatroom/internal/config"
)

// RouterDeps 是路由装配所需的全部依赖。
//
// 抽成 NewRouter 的好处：httptest 里可以直接起一套真实路由做集成测试，
// 与生产环境共用同一份路由表（guide 9.2）。
type RouterDeps struct {
	Cfg      *config.Config
	Auth     *authn.Service
	Handlers *Handlers
	Hub      *chat.Hub
	RDB      redis.UniversalClient // 只用于 readyz；nil 表示不检查 Redis
	Ready    *atomic.Bool          // nil 表示永远就绪
	Logger   *slog.Logger
}

// NewRouter 装配全部路由（guide 5.2）。
func NewRouter(d RouterDeps) http.Handler {
	if d.Logger == nil {
		d.Logger = slog.New(slog.DiscardHandler)
	}
	mux := http.NewServeMux()

	// ---- 探针：liveness 绝不查依赖，readiness 查依赖（guide 7.3）----
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		if d.Ready != nil && !d.Ready.Load() {
			http.Error(w, "draining", http.StatusServiceUnavailable)
			return
		}
		if d.RDB != nil {
			ctx, cancel := context.WithTimeout(r.Context(), 500*time.Millisecond)
			defer cancel()
			if err := d.RDB.Ping(ctx).Err(); err != nil {
				http.Error(w, "redis down", http.StatusServiceUnavailable)
				return
			}
		}
		w.WriteHeader(http.StatusOK)
	})
	mux.Handle("GET /metrics", promhttp.Handler())

	h := d.Handlers

	// ---- 公开端点 ----
	mux.HandleFunc("POST /api/v1/auth/register", h.Register)
	mux.HandleFunc("POST /api/v1/auth/login", h.Login)

	// ---- 需要 JWT 的端点：Authorization: Bearer <jwt> ----
	authed := AuthMiddleware(d.Auth)
	mux.Handle("GET /api/v1/users/me", authed(http.HandlerFunc(h.Me)))
	mux.Handle("GET /api/v1/rooms", authed(http.HandlerFunc(h.ListRooms)))
	mux.Handle("POST /api/v1/rooms", authed(http.HandlerFunc(h.CreateRoom)))
	mux.Handle("GET /api/v1/rooms/{id}", authed(http.HandlerFunc(h.GetRoom)))
	mux.Handle("GET /api/v1/rooms/{id}/members", authed(http.HandlerFunc(h.RoomMembers)))
	mux.Handle("GET /api/v1/rooms/{id}/messages", authed(http.HandlerFunc(h.RoomMessages)))

	// ---- WS：token 走 query，所以不套 AuthMiddleware（guide 1.7）----
	mux.HandleFunc("GET /api/v1/ws", WSHandler(d.Hub, d.Cfg, d.Auth, d.Logger))

	return CORS(d.Cfg.AllowedOrigins)(mux)
}
