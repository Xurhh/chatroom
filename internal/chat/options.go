// Package chat 是并发核心：Hub、Client、双 pump、协议处理与多节点扇出入口。
//
// 分层纪律（guide 0.4）：本包 **不 import internal/store**，
// 所有外部依赖通过 ports.go 里的接口注入，保证并发逻辑可以脱离 Redis 做单测。
package chat

import "time"

// Options 是 chat 包的全部可调参数（guide 1.5 / 2.3 / 2.7）。
//
// 零值会被 withDefaults 补齐，所以调用方只需要写想改的那几项：
//
//	chat.Deps{Opts: chat.Options{PongWait: 90 * time.Second}}
type Options struct {
	// ---- 心跳三件套（guide 1.5）----
	WriteWait  time.Duration // 单次写操作超时
	PongWait   time.Duration // 多久没收到对端任何数据就判死
	PingPeriod time.Duration // 发 Ping 周期，必须略短于 PongWait

	// ---- 连接与背压（guide 1.3 / 2.3）----
	MaxMsgSize int64 // 单帧读上限，防恶意大帧
	SendBuf    int   // 每连接 send channel 容量
	DropKickAt int32 // 连续丢弃多少条判为慢消费者并踢除

	// ---- 各 channel 容量（guide 2.2）----
	RegisterBuf   int
	UnregisterBuf int
	BroadcastBuf  int
	SwitchBuf     int
	MembersBuf    int
	RoomEventBuf  int
	// PresenceEventBuf 是"离线清理"队列容量：正常 leave、切房之外的任何退出路径
	// （尤其是直接断线）都会投一条事件进去，由 presence 协程落 Redis + 通知同房间其他人。
	PresenceEventBuf int

	// ---- 业务限额 ----
	SyncLimit  int64   // join 时最多补拉多少条
	MaxContent int     // 单条 chat 内容字节上限
	RatePerSec float64 // 每连接消息速率上限（令牌桶）
	RateBurst  int     // 每连接令牌桶深度
}

// DefaultOptions 返回 guide 各章给出的经验值。
func DefaultOptions() Options {
	return Options{
		WriteWait:  10 * time.Second,
		PongWait:   60 * time.Second,
		PingPeriod: 54 * time.Second, // = PongWait * 9 / 10
		MaxMsgSize: 8 << 10,          // 8KB
		SendBuf:    256,
		DropKickAt: 3,

		RegisterBuf:      64,
		UnregisterBuf:    256,
		BroadcastBuf:     1024,
		SwitchBuf:        64,
		MembersBuf:       64,
		RoomEventBuf:     256,
		PresenceEventBuf: 1024,

		SyncLimit:  200,
		MaxContent: 4 << 10, // 4KB
		RatePerSec: 10,
		RateBurst:  20,
	}
}

// withDefaults 给零值字段补默认值（只补零值，显式设置的值一律保留）。
func (o Options) withDefaults() Options {
	d := DefaultOptions()
	if o.WriteWait <= 0 {
		o.WriteWait = d.WriteWait
	}
	if o.PongWait <= 0 {
		o.PongWait = d.PongWait
	}
	if o.PingPeriod <= 0 {
		o.PingPeriod = o.PongWait * 9 / 10
	}
	if o.PingPeriod >= o.PongWait {
		o.PingPeriod = o.PongWait * 9 / 10 // 顺序错了一定会反复重连，这里兜底
	}
	if o.MaxMsgSize <= 0 {
		o.MaxMsgSize = d.MaxMsgSize
	}
	if o.SendBuf <= 0 {
		o.SendBuf = d.SendBuf
	}
	if o.DropKickAt <= 0 {
		o.DropKickAt = d.DropKickAt
	}
	if o.RegisterBuf <= 0 {
		o.RegisterBuf = d.RegisterBuf
	}
	if o.UnregisterBuf <= 0 {
		o.UnregisterBuf = d.UnregisterBuf
	}
	if o.BroadcastBuf <= 0 {
		o.BroadcastBuf = d.BroadcastBuf
	}
	if o.SwitchBuf <= 0 {
		o.SwitchBuf = d.SwitchBuf
	}
	if o.MembersBuf <= 0 {
		o.MembersBuf = d.MembersBuf
	}
	if o.RoomEventBuf <= 0 {
		o.RoomEventBuf = d.RoomEventBuf
	}
	if o.PresenceEventBuf <= 0 {
		o.PresenceEventBuf = d.PresenceEventBuf
	}
	if o.SyncLimit <= 0 {
		o.SyncLimit = d.SyncLimit
	}
	if o.MaxContent <= 0 {
		o.MaxContent = d.MaxContent
	}
	if o.RatePerSec <= 0 {
		o.RatePerSec = d.RatePerSec
	}
	if o.RateBurst <= 0 {
		o.RateBurst = d.RateBurst
	}
	return o
}
