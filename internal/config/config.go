// Package config 集中管理环境变量读取。
//
// 默认值面向本地开发；K8s 里由 ConfigMap/Secret 覆盖（deploy/k8s/config.yaml，guide 7.6）。
package config

import (
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Addr     string     // HTTP 监听地址
	Env      string     // 环境名，用于 Redis key 前缀 chat:{env}:...
	LogLevel slog.Level // JSON 日志级别

	RedisAddr     string
	RedisPassword string
	RedisDB       int

	JWTSecret string
	JWTTTL    time.Duration

	AllowedOrigins []string // WS CheckOrigin + CORS 白名单（逗号分隔）

	DefaultRoom     string // 启动时确保存在的房间（M0 开箱即用）
	DefaultRoomName string

	// ---- WS 调参（guide 1.5 / 2.3 / 2.7）----
	PongWait        time.Duration // 读超时；公网移动端可放宽到 90–120s
	SendBuf         int           // 每连接 send channel 容量
	SyncLimit       int64         // join 时最多补拉条数
	RatePerSec      float64       // 每连接消息速率上限
	RateBurst       int           // 每连接令牌桶深度
	MaxContentBytes int           // 单条消息内容上限
	MaxConnections  int64         // 超过该连接数后 Upgrade 前返回 503

	DrainDelay time.Duration // 摘流后等 LB 传播的时间（guide 7.4）
	PprofAddr  string        // pprof 监听地址；空串 = 关闭
}

// Load 读取环境变量并填默认值。
func Load() *Config {
	return &Config{
		Addr:     env("ADDR", ":8080"),
		Env:      env("APP_ENV", "dev"),
		LogLevel: envLevel("LOG_LEVEL", slog.LevelInfo),

		RedisAddr:     env("REDIS_ADDR", "localhost:6379"),
		RedisPassword: env("REDIS_PASSWORD", ""),
		RedisDB:       envInt("REDIS_DB", 0),

		JWTSecret: env("JWT_SECRET", "dev-only-secret-change-me"),
		JWTTTL:    envDuration("JWT_TTL", 24*time.Hour),

		AllowedOrigins: envList("ALLOWED_ORIGINS", []string{"http://localhost:5173"}),

		DefaultRoom:     env("DEFAULT_ROOM", "lobby"),
		DefaultRoomName: env("DEFAULT_ROOM_NAME", "大客厅"),

		PongWait:        envDuration("WS_PONG_WAIT", 60*time.Second),
		SendBuf:         envInt("WS_SEND_BUF", 256),
		SyncLimit:       envInt64("WS_SYNC_LIMIT", 200),
		RatePerSec:      envFloat("WS_RATE_PER_SEC", 10),
		RateBurst:       envInt("WS_RATE_BURST", 20),
		MaxContentBytes: envInt("WS_MAX_CONTENT_BYTES", 4<<10),
		MaxConnections:  envInt64("MAX_CONNECTIONS", 20000),

		DrainDelay: envDuration("DRAIN_DELAY", 8*time.Second),
		// 用 envRaw：显式赋空串 = 关闭 pprof（env 会把空串当成"没设置"）
		PprofAddr: envRaw("PPROF_ADDR", "127.0.0.1:6060"),
	}
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// envRaw 区分"没设置"与"显式设为空串"（后者返回空串）。
func envRaw(key, def string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return def
}

func envDuration(key string, def time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envInt64(key string, def int64) int64 {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return def
}

func envFloat(key string, def float64) float64 {
	if v := os.Getenv(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}

// envList 解析逗号分隔列表，顺手去掉空白项。
func envList(key string, def []string) []string {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return def
	}
	return out
}

func envLevel(key string, def slog.Level) slog.Level {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	var lv slog.Level
	if err := lv.UnmarshalText([]byte(v)); err != nil {
		return def
	}
	return lv
}
