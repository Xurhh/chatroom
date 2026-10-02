// Package config 集中管理环境变量读取。
package config

import (
	"os"
	"strings"
	"time"
)

type Config struct {
	Addr           string   // HTTP 监听地址，默认 :8080
	Env            string   // 环境名，用于 Redis key 前缀 chat:{env}:...
	RedisAddr      string
	JWTSecret      string
	JWTTTL         time.Duration
	AllowedOrigins []string // WS CheckOrigin 白名单
}

func Load() *Config {
	return &Config{
		Addr:           env("ADDR", ":8080"),
		Env:            env("APP_ENV", "dev"),
		RedisAddr:      env("REDIS_ADDR", "localhost:6379"),
		JWTSecret:      env("JWT_SECRET", "dev-only-secret-change-me"),
		JWTTTL:         envDuration("JWT_TTL", 24*time.Hour),
		AllowedOrigins: strings.Split(env("ALLOWED_ORIGINS", "http://localhost:5173"), ","),
	}
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
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
