package room

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"chatroom/internal/store"
)

// Service 层的错误：api 层据此映射 HTTP 状态码（guide 5.1）。
var (
	ErrNotFound = errors.New("room not found")
	ErrInvalid  = errors.New("invalid room")
)

const (
	defaultListLimit = 20
	maxListLimit     = 100
	maxNameLen       = 64
	defaultOwner     = "system" // Ensure 创建的默认房间
)

// Member 是在线成员视图（GET /rooms/{id}/members）。
type Member struct {
	ID   string
	Name string
}

// Service 是房间业务：元数据存 Redis，在线人数来自 presence（guide 4.1 / 4.3）。
type Service struct {
	st  *store.Store
	log *slog.Logger
}

func NewService(st *store.Store, logger *slog.Logger) *Service {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return &Service{st: st, log: logger}
}

// Create 新建房间：ID 由 Redis INCR 生成（r1、r2……），元数据 + 索引一起写。
func (s *Service) Create(ctx context.Context, ownerID, name string) (Room, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > maxNameLen {
		return Room{}, ErrInvalid
	}
	id, err := s.st.NextRoomID(ctx)
	if err != nil {
		return Room{}, err
	}
	created := time.Now()
	if err := s.st.SaveRoomMeta(ctx, store.RoomMeta{
		ID: id, Name: name, OwnerID: ownerID, CreatedAt: created.Unix(),
	}); err != nil {
		return Room{}, err
	}
	return Room{ID: id, Name: name, MemberCount: 0}, nil
}

// Ensure 保证房间存在（启动时创建默认房间，让 M0 开箱即用）。
func (s *Service) Ensure(ctx context.Context, id, name string) error {
	switch _, err := s.st.GetRoomMeta(ctx, id); {
	case err == nil:
		return nil
	case !errors.Is(err, store.ErrRoomNotFound):
		return err
	}
	return s.st.SaveRoomMeta(ctx, store.RoomMeta{
		ID: id, Name: name, OwnerID: defaultOwner, CreatedAt: time.Now().Unix(),
	})
}

// Get 房间详情。在线人数取不到时只记日志、不失败（详情本身仍可用）。
func (s *Service) Get(ctx context.Context, id string) (Room, error) {
	meta, err := s.st.GetRoomMeta(ctx, id)
	if errors.Is(err, store.ErrRoomNotFound) {
		return Room{}, ErrNotFound
	}
	if err != nil {
		return Room{}, err
	}
	count, err := s.st.PresenceCount(ctx, id)
	if err != nil {
		s.log.Warn("presence count failed", "room", id, "err", err)
	}
	return Room{ID: meta.ID, Name: meta.Name, MemberCount: count}, nil
}

// Meta 返回持久化元数据（需要 owner / 创建时间时用）。
func (s *Service) Meta(ctx context.Context, id string) (Meta, error) {
	meta, err := s.st.GetRoomMeta(ctx, id)
	if errors.Is(err, store.ErrRoomNotFound) {
		return Meta{}, ErrNotFound
	}
	if err != nil {
		return Meta{}, err
	}
	return Meta{
		ID: meta.ID, Name: meta.Name, OwnerID: meta.OwnerID,
		CreatedAt: time.Unix(meta.CreatedAt, 0),
	}, nil
}

// List 按创建时间倒序分页。cursor 是上一页的 next_cursor（空串 = 首页）。
func (s *Service) List(ctx context.Context, cursor string, limit int) ([]Room, string, error) {
	if limit <= 0 {
		limit = defaultListLimit
	}
	if limit > maxListLimit {
		limit = maxListLimit
	}
	metas, next, err := s.st.ListRoomMeta(ctx, cursor, limit)
	if err != nil {
		return nil, "", err
	}
	out := make([]Room, 0, len(metas))
	for _, m := range metas {
		count, err := s.st.PresenceCount(ctx, m.ID)
		if err != nil {
			s.log.Warn("presence count failed", "room", m.ID, "err", err)
		}
		out = append(out, Room{ID: m.ID, Name: m.Name, MemberCount: count})
	}
	nextCursor := ""
	if len(metas) == limit { // 拿满一页才给游标，否则前端会多请求一次空页
		nextCursor = strconv.Itoa(next)
	}
	return out, nextCursor, nil
}

// Members 在线成员快照（presence 惰性过期过滤后的结果）。
func (s *Service) Members(ctx context.Context, roomID string) ([]Member, error) {
	m, err := s.st.PresenceMembers(ctx, roomID)
	if err != nil {
		return nil, err
	}
	out := make([]Member, 0, len(m))
	for uid, name := range m {
		out = append(out, Member{ID: uid, Name: name})
	}
	return out, nil
}
