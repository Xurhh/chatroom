// Command server 装配：config → redis → hub → mux → server → 优雅关停（guide 3.4）。
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/redis/go-redis/v9"

	"chatroom/internal/api"
	"chatroom/internal/authn"
	"chatroom/internal/config"
	"chatroom/internal/store"
)

var ready atomic.Int32

func main() {
	cfg := config.Load()
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))

	rdb := redis.NewClient(&redis.Options{Addr: cfg.RedisAddr})
	auth := authn.New(cfg.JWTSecret, cfg.JWTTTL)
	st := store.New(rdb, store.NewKeys(cfg.Env), hostname())
	h := api.NewHandlers(auth, st, logger)

	mux := buildMux(cfg, auth, h, rdb)

	srv := &http.Server{Addr: cfg.Addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server crashed", "err", err)
			os.Exit(1)
		}
	}()
	ready.Store(1)
	logger.Info("listening", "addr", cfg.Addr)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
	logger.Info("shutting down")

	ready.Store(0)                    // 1) 摘流：readyz 503
	time.Sleep(8 * time.Second)       // 2) 等 LB 传播
	shCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_ = srv.Shutdown(shCtx)           // 3) 停新连接
	// 4) TODO(M0): hub.Close(); hub.Wait()  —— 接入 chat.Hub 后启用
	logger.Info("bye")
}

func buildMux(cfg *config.Config, auth *authn.Service, h *api.Handlers, rdb *redis.Client) *http.ServeMux {
	mux := http.NewServeMux()

	// 探针：liveness 绝不查依赖（guide 7.3）
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if ready.Load() == 0 {
			http.Error(w, "draining", http.StatusServiceUnavailable)
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		defer cancel()
		if err := rdb.Ping(ctx).Err(); err != nil {
			http.Error(w, "redis down", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	mux.Handle("GET /metrics", promhttp.Handler())

	// REST（guide 5.2）
	mux.HandleFunc("POST /api/v1/auth/register", h.Register)
	mux.HandleFunc("POST /api/v1/auth/login", h.Login)

	authed := api.AuthMiddleware(auth)
	mux.Handle("GET /api/v1/users/me", authed(http.HandlerFunc(h.Me)))
	mux.Handle("GET /api/v1/rooms", authed(http.HandlerFunc(h.ListRooms)))
	mux.Handle("POST /api/v1/rooms", authed(http.HandlerFunc(h.CreateRoom)))
	mux.Handle("GET /api/v1/rooms/{id}", authed(http.HandlerFunc(h.GetRoom)))
	mux.Handle("GET /api/v1/rooms/{id}/members", authed(http.HandlerFunc(h.RoomMembers)))
	mux.Handle("GET /api/v1/rooms/{id}/messages", authed(http.HandlerFunc(h.RoomMessages)))

	// TODO(M0): mux.HandleFunc("GET /api/v1/ws", api.WSHandler(hub, cfg, auth, logger))
	return mux
}

func hostname() string {
	h, _ := os.Hostname()
	return h
}
