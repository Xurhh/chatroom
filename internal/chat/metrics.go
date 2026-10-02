// Package chat 可观测性指标（guide 2.9）。
package chat

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	Connections = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "ws_connections",
		Help: "当前 WS 连接数",
	})
	MessagesSent = promauto.NewCounter(prometheus.CounterOpts{
		Name: "ws_messages_sent_total",
		Help: "下行消息总数",
	})
	MessagesReceived = promauto.NewCounter(prometheus.CounterOpts{
		Name: "ws_messages_received_total",
		Help: "上行消息总数",
	})
	BroadcastDropped = promauto.NewCounter(prometheus.CounterOpts{
		Name: "ws_broadcast_dropped_total",
		Help: "背压丢弃总数",
	})
	BroadcastDuration = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "ws_broadcast_duration_seconds",
		Help:    "单次扇出耗时",
		Buckets: prometheus.ExponentialBuckets(0.0005, 2, 12),
	})
	ReadErrors = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "ws_read_errors_total",
		Help: "读错误（按类型）",
	}, []string{"kind"}) // timeout | close | bad_frame
)
