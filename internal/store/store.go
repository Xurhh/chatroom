// Package store Redis 封装：历史、presence、去重、扇出。
package store

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"chatroom/internal/chat"
)

const (
	msgMaxLen        = 10000 // Stream 近似裁剪上限（guide 4.2）
	dedupTTL         = 300 * time.Second
	presenceTTL      = 90  // presence 条目内嵌过期秒数（惰性过期）
	dedupPlaceholder = "-" // 占位值：已占位、seq 还没回填
)

// Message 是 Stream 里一条消息的扁平字段视图。
//
// 它是 chat.Record 的别名：端口（chat.History）定义在 chat 包，
// 实现（*Store）在 store 包，中间不需要任何类型转换代码。
type Message = chat.Record

type Store struct {
	rdb  redis.UniversalClient
	keys *Keys
	node string // 本节点 ID（写进 presence 值里，便于定位连接挂在哪个 Pod）
}

func New(rdb redis.UniversalClient, keys *Keys, nodeID string) *Store {
	return &Store{rdb: rdb, keys: keys, node: nodeID}
}

// RDB 暴露底层客户端（只在装配层与集成测试里用）。
func (s *Store) RDB() redis.UniversalClient { return s.rdb }

// Keys 暴露 key 生成器（扇出适配器、巡检脚本用）。
func (s *Store) Keys() *Keys { return s.keys }

// ---------- 消息历史（Stream，guide 4.2） ----------

// Append 追加消息，返回的 Stream ID 即 seq（与存储天然强一致）。
func (s *Store) Append(ctx context.Context, roomID string, m Message) (string, error) {
	return s.rdb.XAdd(ctx, &redis.XAddArgs{
		Stream: s.keys.Msgs(roomID),
		MaxLen: msgMaxLen,
		Approx: true, // ~ 近似裁剪：O(1) 写入，略多于 1 万条无妨
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

// Since 补拉 lastSeq 之后的增量（重连追帧 / 丢失补偿）。
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

// ---------- 幂等去重（guide 2.10 / 4.1） ----------

// DedupClaim 幂等占位：
//   - 返回 (true, "", nil)   = 首次出现，调用方可以落库；
//   - 返回 (false, seq, nil) = 重复消息，seq 是首次落库拿到的 Stream ID；
//   - 返回 (false, "", nil)  = 重复，但原消息还没写完 seq（调用方让客户端稍后重试）。
//
// 占位与回填分两步是有意的：seq 只有 XADD 之后才知道，而"占位"必须先于 XADD，
// 否则同一 client_msg_id 并发重发会写进两条。
func (s *Store) DedupClaim(ctx context.Context, roomID, clientMsgID string) (bool, string, error) {
	key := s.keys.Dedup(roomID, clientMsgID)
	claimed, err := s.rdb.SetNX(ctx, key, dedupPlaceholder, dedupTTL).Result()
	if err != nil || claimed {
		return claimed, "", err
	}
	v, err := s.rdb.Get(ctx, key).Result()
	if err == redis.Nil { // 恰好过期：当作重复处理，客户端重试即可（SETNX 会成功）
		return false, "", nil
	}
	if err != nil {
		return false, "", err
	}
	if v == dedupPlaceholder {
		return false, "", nil
	}
	return false, v, nil
}

// DedupRecordSeq 把权威 seq 回填进去（只更新仍然存在的占位，避免"复活"已释放的 key）。
func (s *Store) DedupRecordSeq(ctx context.Context, roomID, clientMsgID, seq string) error {
	_, err := s.rdb.SetXX(ctx, s.keys.Dedup(roomID, clientMsgID), seq, dedupTTL).Result()
	return err
}

// DedupRelease 落库失败时释放占位，让客户端可以安全重试。
func (s *Store) DedupRelease(ctx context.Context, roomID, clientMsgID string) error {
	return s.rdb.Del(ctx, s.keys.Dedup(roomID, clientMsgID)).Err()
}

// ---------- 在线状态 presence（guide 4.3） ----------

// PresenceJoin 登记在线并续期；值 = nodeID:name:过期时间戳。
func (s *Store) PresenceJoin(ctx context.Context, roomID, userID, name string) error {
	exp := time.Now().Unix() + presenceTTL
	return s.rdb.HSet(ctx, s.keys.Presence(roomID), userID,
		fmt.Sprintf("%s:%s:%d", s.node, name, exp)).Err()
}

// PresenceLeave 正常退出时删除在线记录。
func (s *Store) PresenceLeave(ctx context.Context, roomID, userID string) error {
	return s.rdb.HDel(ctx, s.keys.Presence(roomID), userID).Err()
}

// PresenceMembers 读在线成员（惰性过滤过期条目）：map[userID]name。
func (s *Store) PresenceMembers(ctx context.Context, roomID string) (map[string]string, error) {
	raw, err := s.rdb.HGetAll(ctx, s.keys.Presence(roomID)).Result()
	if err != nil {
		return nil, err
	}
	now := time.Now().Unix()
	out := make(map[string]string, len(raw))
	for uid, v := range raw {
		exp, ok := presenceExpiry(v)
		if !ok || exp <= now {
			continue // 惰性过期：读到过期条目直接视为离线
		}
		if name, ok := presenceName(v); ok {
			out[uid] = name
		}
	}
	return out, nil
}

// PresenceCount 当前在线人数（过滤过期后的准确值；房间列表用它填 member_count）。
func (s *Store) PresenceCount(ctx context.Context, roomID string) (int, error) {
	m, err := s.PresenceMembers(ctx, roomID)
	if err != nil {
		return 0, err
	}
	return len(m), nil
}

// CleanupPresence 清理过期条目（guide 4.3：后台每 60s 对活跃房间跑一次）。
//
// TODO(M1): 在 main 里起定时任务，对最近活跃的房间调用本函数。
func (s *Store) CleanupPresence(ctx context.Context, roomID string) (int, error) {
	raw, err := s.rdb.HGetAll(ctx, s.keys.Presence(roomID)).Result()
	if err != nil {
		return 0, err
	}
	now := time.Now().Unix()
	stale := make([]string, 0, len(raw))
	for uid, v := range raw {
		if exp, ok := presenceExpiry(v); ok && exp <= now {
			stale = append(stale, uid)
		}
	}
	if len(stale) == 0 {
		return 0, nil
	}
	n, err := s.rdb.HDel(ctx, s.keys.Presence(roomID), stale...).Result()
	return int(n), err
}

// presenceExpiry 从 "node:name:exp" 里取过期时间戳。
func presenceExpiry(v string) (int64, bool) {
	i := strings.LastIndexByte(v, ':')
	if i < 0 {
		return 0, false
	}
	exp, err := strconv.ParseInt(v[i+1:], 10, 64)
	if err != nil {
		return 0, false
	}
	return exp, true
}

// presenceName 从 "node:name:exp" 里取用户名（name 本身允许含冒号）。
func presenceName(v string) (string, bool) {
	i := strings.LastIndexByte(v, ':')
	if i < 0 {
		return "", false
	}
	parts := strings.SplitN(v[:i], ":", 2)
	if len(parts) != 2 {
		return "", false
	}
	return parts[1], true
}

// ---------- 扇出（Pub/Sub，guide 4.4） ----------

// Publish 向房间频道发布已序列化的 envelope（尽力而为）。
func (s *Store) Publish(ctx context.Context, roomID string, payload []byte) error {
	return s.rdb.Publish(ctx, s.keys.Events(roomID), payload).Err()
}

// 订阅端见 fanout.go 的 *Fanout（实现 chat.Subscriber）。
