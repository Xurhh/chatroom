// Package store Redis key 命名与底层封装。
package store

import "fmt"

// Keys 统一管理 chat:{env}:... 前缀下的所有 key（见 guide 4.1）。
type Keys struct {
	env string
}

func NewKeys(env string) *Keys { return &Keys{env: env} }

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
