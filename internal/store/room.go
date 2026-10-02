package store

import (
	"context"
	"errors"
	"strconv"

	"github.com/redis/go-redis/v9"
)

// ErrRoomNotFound 房间元数据不存在（api 层映射成 404 room_not_found）。
var ErrRoomNotFound = errors.New("room not found")

// RoomMeta 是房间的持久化元数据（guide 4.1 的 chat:{env}:room:{id}:meta）。
//
// 这里刻意不复用 room.Meta：room 包依赖 store，store 再依赖 room 会形成循环。
// 转换放在 room 包的 service 里。
type RoomMeta struct {
	ID        string
	Name      string
	OwnerID   string
	CreatedAt int64 // Unix 秒
}

// NextRoomID 用 INCR 生成人类可读的房间 ID：r1、r2……
func (s *Store) NextRoomID(ctx context.Context) (string, error) {
	n, err := s.rdb.Incr(ctx, s.keys.RoomSeq()).Result()
	if err != nil {
		return "", err
	}
	return "r" + strconv.FormatInt(n, 10), nil
}

// SaveRoomMeta 写房间元数据，并把它挂进房间索引（ZSET，score = 创建时间）。
func (s *Store) SaveRoomMeta(ctx context.Context, m RoomMeta) error {
	pipe := s.rdb.TxPipeline()
	pipe.HSet(ctx, s.keys.Meta(m.ID), map[string]any{
		"id":         m.ID,
		"name":       m.Name,
		"owner_id":   m.OwnerID,
		"created_at": m.CreatedAt,
	})
	pipe.ZAdd(ctx, s.keys.RoomsIndex(), redis.Z{Score: float64(m.CreatedAt), Member: m.ID})
	_, err := pipe.Exec(ctx)
	return err
}

// GetRoomMeta 读单个房间元数据；不存在返回 ErrRoomNotFound。
func (s *Store) GetRoomMeta(ctx context.Context, roomID string) (RoomMeta, error) {
	h, err := s.rdb.HGetAll(ctx, s.keys.Meta(roomID)).Result()
	if err != nil {
		return RoomMeta{}, err
	}
	if len(h) == 0 {
		return RoomMeta{}, ErrRoomNotFound
	}
	created, _ := strconv.ParseInt(h["created_at"], 10, 64)
	return RoomMeta{
		ID:        h["id"],
		Name:      h["name"],
		OwnerID:   h["owner_id"],
		CreatedAt: created,
	}, nil
}

// ListRoomMeta 按创建时间倒序分页列出房间。
//
// cursor 是上一页返回的 offset 字符串（空串 = 首页）；返回的 next 是下一頁 offset。
//
// TODO(M1): 房间多起来后改成 pipeline / MGET 批量取 meta，去掉这里的 N+1 次 HGETALL。
func (s *Store) ListRoomMeta(ctx context.Context, cursor string, limit int) ([]RoomMeta, int, error) {
	if limit <= 0 {
		limit = 20
	}
	offset, _ := strconv.Atoi(cursor)
	ids, err := s.rdb.ZRevRange(ctx, s.keys.RoomsIndex(),
		int64(offset), int64(offset+limit-1)).Result()
	if err != nil {
		return nil, offset, err
	}
	out := make([]RoomMeta, 0, len(ids))
	for _, id := range ids {
		m, err := s.GetRoomMeta(ctx, id)
		if errors.Is(err, ErrRoomNotFound) {
			continue // 索引里有、meta 已过期：跳过（可加后台清理）
		}
		if err != nil {
			return nil, offset, err
		}
		out = append(out, m)
	}
	return out, offset + len(ids), nil
}
