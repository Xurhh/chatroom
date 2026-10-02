// Command server 装配：config → redis → store → hub → router → 优雅关停（guide 3.4）。
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

	"github.com/redis/go-redis/v9"

	"chatroom/internal/api"
	"chatroom/internal/authn"
	"chatroom/internal/chat"
	"chatroom/internal/config"
	"chatroom/internal/room"
	"chatroom/internal/store"
)

// ready 是 readiness 开关：关停时先置 false，让 K8s 把本 Pod 摘出 Service（guide 7.4）。
var ready atomic.Bool

func main() {
	// TODO(M2): 容器内 GOMAXPROCS 默认取宿主机核数（不是 Pod 的 CPU limit）。
	// 引入 go.uber.org/automaxprocs 后在这里加一行：
	//   _, _ = maxprocs.Set()
	// 另外生产请设 GOMEMLIMIT（略低于 memory limit），见 deploy/k8s/config.yaml。

	cfg := config.Load()
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))
	logger.Info("starting", "env", cfg.Env, "addr", cfg.Addr, "redis", cfg.RedisAddr)

	rdb := redis.NewClient(&redis.Options{
		Addr:     cfg.RedisAddr,
		Password: cfg.RedisPassword,
		DB:       cfg.RedisDB,
	})
	defer func() { _ = rdb.Close() }()

	st := store.New(rdb, store.NewKeys(cfg.Env), hostname())

	// 根 context：进程退出时一并取消扇出协程等后台任务。
	rootCtx, stopRoot := context.WithCancel(context.Background())
	defer stopRoot()

	// ---- 并发核心：Hub 起单 goroutine，扇出协程消费 Redis Pub/Sub（guide 2.2 / 4.4）----
	hub := chat.NewHub(chat.Deps{Store: st, Logger: logger, Opts: chatOptions(cfg)})
	hub.Start()
	go chat.RunFanout(rootCtx, hub, st.NewFanout(rootCtx), logger)

	// ---- 房间业务 ----
	rooms := room.NewService(st, logger)
	bootCtx, bootCancel := context.WithTimeout(context.Background(), 3*time.Second)
	if err := rooms.Ensure(bootCtx, cfg.DefaultRoom, cfg.DefaultRoomName); err != nil {
		logger.Warn("ensure default room failed (Redis 还没起来?)", "room", cfg.DefaultRoom, "err", err)
	}
	bootCancel()

	// ---- REST + WS 路由 ----
	auth := authn.New(cfg.JWTSecret, cfg.JWTTTL)
	handlers := api.NewHandlers(auth, st, rooms, logger)
	router := api.NewRouter(api.RouterDeps{
		Cfg:      cfg,
		Auth:     auth,
		Handlers: handlers,
		Hub:      hub,
		RDB:      rdb, // readyz 查它；nil 表示不查
		Ready:    &ready,
		Logger:   logger,
	})

	srv := &http.Server{Addr: cfg.Addr, Handler: router, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("server crashed", "err", err)
			os.Exit(1)
		}
	}()

	pprofSrv := startPprof(cfg, logger) // 内网 pprof（guide 2.9）
	ready.Store(true)
	logger.Info("listening", "addr", cfg.Addr, "pprof", cfg.PprofAddr)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
	logger.Info("shutting down", "conns", hub.Connections())

	// 1) 摘流：readyz 变成 503 → K8s Service 摘除本 Pod（guide 2.6 / 7.4）
	ready.Store(false)
	// 2) 等负载均衡传播（等价于 preStop sleep，且不依赖镜像里有 shell）
	time.Sleep(cfg.DrainDelay)
	// 3) 停止接受新连接、放掉空闲 keep-alive 连接。
	//    注意：WS 连接在 Upgrade 时就被 hijack 了，net/http 的 Shutdown 既不等它们、
	//    也不会关它们（文档原话："does not attempt to close nor wait for hijacked
	//    connections such as WebSockets"）。所以存量长连接必须由第 4 步自己处理。
	shCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	go func() { _ = srv.Shutdown(shCtx) }()
	// 4) 主动通知并等待存量 WS：发 1000 Close 帧 → 关连接 → 两个 pump 退出
	hub.Close()
	hub.Wait()

	stopRoot() // 收掉扇出协程
	if pprofSrv != nil {
		_ = pprofSrv.Shutdown(shCtx)
	}
	logger.Info("bye")
}

// chatOptions 把 config 的 WS 参数映射成 chat.Options，其余项沿用 chat 包默认值。
func chatOptions(cfg *config.Config) chat.Options {
	return chat.Options{
		PongWait:   cfg.PongWait,
		SendBuf:    cfg.SendBuf,
		SyncLimit:  cfg.SyncLimit,
		RatePerSec: cfg.RatePerSec,
		RateBurst:  cfg.RateBurst,
		MaxContent: cfg.MaxContentBytes,
	}
}

func hostname() string {
	h, _ := os.Hostname()
	return h
}
