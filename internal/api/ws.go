package api

import (
	"log/slog"
	"net/http"
	"slices"

	"github.com/gorilla/websocket"

	"chatroom/internal/authn"
	"chatroom/internal/chat"
	"chatroom/internal/config"
)

// WSHandler 是 WS 入口：先鉴权、再 Upgrade（guide 1.3 / 3.5）。
//
// token 走 query（guide 1.7 的决策）：浏览器的 new WebSocket() 无法自定义 HTTP 头。
// TODO(M1): 若担心 token 进 access log，可在这里额外支持 Sec-WebSocket-Protocol 方案。
func WSHandler(hub *chat.Hub, cfg *config.Config, auth *authn.Service, logger *slog.Logger) http.HandlerFunc {
	upgrader := websocket.Upgrader{
		ReadBufferSize:  1024, // 每连接内存下限，万人在线要算账（guide 1.3）
		WriteBufferSize: 1024,
		CheckOrigin:     originChecker(cfg.AllowedOrigins),
	}
	maxConns := cfg.MaxConnections

	return func(w http.ResponseWriter, r *http.Request) {
		// 1) 过载保护：量到了就拒新连接，不杀存量（guide 2.7）
		if maxConns > 0 && hub.Connections() >= maxConns {
			http.Error(w, "server overloaded", http.StatusServiceUnavailable)
			return
		}

		// 2) Upgrade 前鉴权：失败直接 HTTP 401，干净且日志友好（guide 5.4）
		claims, err := auth.Verify(r.URL.Query().Get("token"))
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		// 3) Upgrade。失败时 gorilla 已经写过响应，这里只记日志
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			logger.Warn("ws upgrade failed", "err", err, "remote", r.RemoteAddr)
			return
		}

		// 4) 建连接 → 登记 → 起双泵（顺序：先写泵后读泵，guide 3.5）
		c := chat.NewClient(hub, conn, claims.UserID, claims.Name)
		if !hub.Join(c) {
			return // 过载 / 关停中，Join 已经关掉连接
		}
		c.Start()
		// 连接数用 ws_connections 指标看；这里不读 hub.Connections()，
		// 因为登记是异步的，刚 Join 完读到的值可能还没更新。
		logger.Info("ws connected", "uid", c.UserID)
	}
}

// originChecker 校验 Origin 白名单：不校验 = 跨站 WebSocket 劫持（CSWSH，guide 1.3）。
func originChecker(allowed []string) func(*http.Request) bool {
	return func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true // 非浏览器客户端（压测工具、App）没有 Origin
		}
		return slices.Contains(allowed, origin)
	}
}
