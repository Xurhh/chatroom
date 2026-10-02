// Package room 房间业务模型（元数据存 Redis）。
package room

import "time"

// Room 是房间的对外视图。
type Room struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	MemberCount int    `json:"member_count"` // 在线人数（来自 presence）
}

// Meta 是房间的持久化元数据（存 Redis Hash）。
type Meta struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	OwnerID   string    `json:"owner_id"`
	CreatedAt time.Time `json:"created_at"`
}
