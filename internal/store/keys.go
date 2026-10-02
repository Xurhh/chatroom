// Package store Redis key 命名与底层封装。
package store

import (
	"fmt"
	"strings"
)

// Keys 统一管理 chat:{env}:... 前缀下的所有 key（见 guide 4.1）。
type Keys struct {
	env string
}

func NewKeys(env string) *Keys { return &Keys{env: env} }

// Env 返回环境名（日志/巡检用）。
func (k *Keys) Env() string { return k.env }

// Msgs 房间消息 Stream：chat:prod:room:{id}:msgs
func (k *Keys) Msgs(roomID string) string {
	return fmt.Sprintf("chat:%s:room:%s:msgs", k.env, roomID)
}

// Presence 房间在线成员 Hash：chat:prod:room:{id}:presence
func (k *Keys) Presence(roomID string) string {
	return fmt.Sprintf("chat:%s:room:%s:presence", k.env, roomID)
}

// Dedup 消息去重 String：chat:prod:dedup:{room}:{clientMsgID}
func (k *Keys) Dedup(roomID, clientMsgID string) string {
	return fmt.Sprintf("chat:%s:dedup:%s:%s", k.env, roomID, clientMsgID)
}

// Meta 房间元数据 Hash：chat:prod:room:{id}:meta
func (k *Keys) Meta(roomID string) string {
	return fmt.Sprintf("chat:%s:room:%s:meta", k.env, roomID)
}

// Events 房间扇出 Pub/Sub 频道：chat:prod:room:{id}:events
func (k *Keys) Events(roomID string) string {
	return fmt.Sprintf("chat:%s:room:%s:events", k.env, roomID)
}

// EventsPattern 所有房间的扇出频道通配：chat:prod:room:*:events
func (k *Keys) EventsPattern() string {
	return fmt.Sprintf("chat:%s:room:*:events", k.env)
}

// RoomFromChannel 从频道名反解房间 ID（扇出协程用）。
func (k *Keys) RoomFromChannel(channel string) (string, bool) {
	prefix := fmt.Sprintf("chat:%s:room:", k.env)
	const suffix = ":events"
	if !strings.HasPrefix(channel, prefix) || !strings.HasSuffix(channel, suffix) {
		return "", false
	}
	id := strings.TrimSuffix(strings.TrimPrefix(channel, prefix), suffix)
	if id == "" || strings.Contains(id, ":") {
		return "", false
	}
	return id, true
}

// RoomsIndex 房间索引（ZSET，score = 创建时间，member = roomID），用于列表分页。
func (k *Keys) RoomsIndex() string {
	return fmt.Sprintf("chat:%s:rooms", k.env)
}

// RoomSeq 房间 ID 自增序列（INCR → r1、r2……）。
func (k *Keys) RoomSeq() string {
	return fmt.Sprintf("chat:%s:room:seq", k.env)
}
