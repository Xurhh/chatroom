package main

import (
	"errors"
	"log/slog"
	"net/http"
	_ "net/http/pprof" // 注册 /debug/pprof/* 到 DefaultServeMux
	"time"

	"chatroom/internal/config"
)

// startPprof 在内网端口暴露 pprof（guide 2.9）：
// goroutine 数是排查泄漏的第一现场，健康值 ≈ 2×连接数 + 常数。
//
// PPROF_ADDR 为空串则关闭。
func startPprof(cfg *config.Config, logger *slog.Logger) *http.Server {
	if cfg.PprofAddr == "" {
		return nil
	}
	srv := &http.Server{
		Addr:              cfg.PprofAddr,
		Handler:           http.DefaultServeMux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Warn("pprof server stopped", "addr", cfg.PprofAddr, "err", err)
		}
	}()
	return srv
}
