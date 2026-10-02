// Package store Redis 封装：历史、presence、去重、扇出。
package store

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	msgMaxLen  = 10000           // Stream 近似裁剪上限
	dedupTTL   = 300 * time.Second
	presenceTTL = 90            // presence 条目内嵌过期秒数（惰性过期）
)

// Message 是 Stream 里一条消息的扁平字段视图。
type Message struct {
	Seq     string
	UserID  string
	Name    string
	Content string
	TS      int64
}

type Store struct {
	rdb  redis.UniversalClient
	keys *Keys
	node string // 本节点 ID（写进 presence 值里）
}

func New(rdb redis.UniversalClient, keys *Keys, nodeID string) *Store {
	return &Store{rdb: rdb, keys: keys, node: nodeID}
}

// ---------- 消息历史（Stream，guide 4.2） ----------

// Append 追加消息，返回的 Stream ID 即 seq（与存储天然强一致）。
func (s *Store) Append(ctx context.Context, roomID string, m Message) (string, error) {
	return s.rdb.XAdd(ctx, &redis.XAddArgs{
		Stream: s.keys.Msgs(roomID),
		MaxLen: msgMaxLen,
		Approx: true,
		Values: []string{
			"uid", m.UserID, "name", m.Name,
			"body", m.Content, "ts", strconv.FormatInt(m.TS, 10),
		},
	}).Result()
}

// History 倒序取最近一页（新→旧）。beforeSeq 为空表示从最新开始。
func (s *Store) History(ctx context.Context, roomID, beforeSeq string, limit int64) ([]Message, error) {
	start := "+"
	if beforeSeq != "" {
		start = "(" + beforeSeq // 开区间，不含该条
	}
	xms, err := s.rdb.XRevRangeN(ctx, s.keys.Msgs(roomID), start, "-", limit).Result()
	if err != nil {
		return nil, err
	}
	return toMessages(xms), nil
}

// Since 补拉 lastSeq 之后的增量（重连追帧）。
func (s *Store) Since(ctx context.Context, roomID, lastSeq string, limit int64) ([]Message, error) {
	start := "-"
	if lastSeq != "" {
		start = "(" + lastSeq
	}
	xms, err := s.rdb.XRangeN(ctx, s.keys.Msgs(roomID), start, "+", limit).Result()
	if err != nil {
		return nil, err
	}
	return toMessages(xms), nil
}

func toMessages(xms []redis.XMessage) []Message {
	out := make([]Message, 0, len(xms))
	for _, xm := range xms {
		ts, _ := strconv.ParseInt(fmt.Sprint(xm.Values["ts"]), 10, 64)
		out = append(out, Message{
			Seq:     xm.ID,
			UserID:  fmt.Sprint(xm.Values["uid"]),
			Name:    fmt.Sprint(xm.Values["name"]),
			Content: fmt.Sprint(xm.Values["body"]),
			TS:      ts,
		})
	}
	return out
}

// ---------- 幂等去重（guide 4.1） ----------

// Dedup 返回 true 表示首次出现；false 表示重复消息。
func (s *Store) Dedup(ctx context.Context, roomID, clientMsgID string) (bool, error) {
	return s.rdb.SetNX(ctx, s.keys.Dedup(roomID, clientMsgID), 1, dedupTTL).Result()
}

// ---------- 在线状态 presence（guide 4.3） ----------

// PresenceJoin 登记在线；值 = nodeID:过期时间戳。
func (s *Store) PresenceJoin(ctx context.Context, roomID, userID, name string) error {
	exp := time.Now().Unix() + presenceTTL
	return s.rdb.HSet(ctx, s.keys.Presence(roomID), userID,
		fmt.Sprintf("%s:%s:%d", s.node, name, exp)).Err()
}

func (s *Store) PresenceLeave(ctx context.Context, roomID, userID string) error {
	return s.rdb.HDel(ctx, s.keys.Presence(roomID), userID).Err()
}

// PresenceMembers 读在线成员（惰性过滤过期条目）。
func (s *Store) PresenceMembers(ctx context.Context, roomID string) (map[string]string, error) {
	raw, err := s.rdb.HGetAll(ctx, s.keys.Presence(roomID)).Result()
	if err != nil {
		return nil, err
	}
	now := time.Now().Unix()
	out := make(map[string]string, len(raw))
	for uid, v := range raw {
		// v = node:name:exp（按最后一个冒号切出过期时间戳）
		i := strings.LastIndexByte(v, ':')
		if i < 0 {
			continue
		}
		exp, err := strconv.ParseInt(v[i+1:], 10, 64)
		if err != nil || exp <= now {
			continue // 惰性过期
		}
		parts := strings.SplitN(v[:i], ":", 2)
		if len(parts) == 2 {
			out[uid] = parts[1]
		}
	}
	return out, nil
}

// ---------- 扇出（Pub/Sub，guide 4.4） ----------

// Publish 向房间频道发布已序列化的 envelope（尽力而为）。
func (s *Store) Publish(ctx context.Context, roomID string, payload []byte) error {
	return s.rdb.Publish(ctx, s.keys.Events(roomID), payload).Err()
}

// Subscribe 订阅房间频道。
func (s *Store) Subscribe(ctx context.Context, roomIDs ...string) *redis.PubSub {
	chs := make([]string, len(roomIDs))
	for i, id := range roomIDs {
		chs[i] = s.keys.Events(id)
	}
	return s.rdb.Subscribe(ctx, chs...)
}
