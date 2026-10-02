package api

import (
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/google/uuid"

	"chatroom/internal/authn"
	"chatroom/internal/chat"
	"chatroom/internal/room"
	"chatroom/internal/store"
)

// Handlers 聚合所有 REST handler 的依赖。
type Handlers struct {
	Auth   *authn.Service
	Store  *store.Store
	Rooms  *room.Service
	Logger *slog.Logger

	// M0 先用内存用户表占位（多副本/重启都会丢）。
	// TODO(M1): 换成 DB + bcrypt/argon2 哈希；注意 register 与 login 都要走同一个存储。
	mu    sync.RWMutex
	users map[string]userRecord
}

type userRecord struct {
	ID       string
	Name     string
	Password string // TODO: bcrypt 哈希
}

func NewHandlers(auth *authn.Service, st *store.Store, rooms *room.Service, logger *slog.Logger) *Handlers {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return &Handlers{
		Auth:   auth,
		Store:  st,
		Rooms:  rooms,
		Logger: logger,
		users:  make(map[string]userRecord),
	}
}

// ---------- auth ----------

type authReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (h *Handlers) Register(w http.ResponseWriter, r *http.Request) {
	var req authReq
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Username == "" || len(req.Password) < 6 {
		badRequest(w, "username required, password min 6 chars")
		return
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	if _, taken := h.users[req.Username]; taken {
		badRequest(w, "username taken")
		return
	}
	u := userRecord{ID: "u_" + uuid.NewString()[:8], Name: req.Username, Password: req.Password}
	h.users[req.Username] = u

	writeJSON(w, http.StatusCreated, map[string]any{
		"user_id":    u.ID,
		"created_at": time.Now().Unix(),
	})
}

func (h *Handlers) Login(w http.ResponseWriter, r *http.Request) {
	var req authReq
	if !decodeJSON(w, r, &req) {
		return
	}

	h.mu.RLock()
	u, ok := h.users[req.Username]
	h.mu.RUnlock()
	if !ok || u.Password != req.Password {
		unauthorized(w, "wrong username or password")
		return
	}

	token, exp, err := h.Auth.Issue(u.ID, u.Name)
	if err != nil {
		internalErr(w, h.Logger, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"token":      token,
		"expires_at": exp,
		"user":       chat.User{ID: u.ID, Name: u.Name},
	})
}

func (h *Handlers) Me(w http.ResponseWriter, r *http.Request) {
	c := ClaimsFrom(r)
	writeJSON(w, http.StatusOK, chat.User{ID: c.UserID, Name: c.Name})
}

// ---------- rooms ----------

func (h *Handlers) ListRooms(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	rooms, next, err := h.Rooms.List(r.Context(), r.URL.Query().Get("cursor"), limit)
	if err != nil {
		internalErr(w, h.Logger, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"rooms":       rooms,
		"next_cursor": next,
	})
}

type createRoomReq struct {
	Name string `json:"name"`
}

func (h *Handlers) CreateRoom(w http.ResponseWriter, r *http.Request) {
	var req createRoomReq
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Name == "" {
		badRequest(w, "name required")
		return
	}
	claims := ClaimsFrom(r)
	created, err := h.Rooms.Create(r.Context(), claims.UserID, req.Name)
	switch {
	case errors.Is(err, room.ErrInvalid):
		badRequest(w, "invalid room name")
	case err != nil:
		internalErr(w, h.Logger, err)
	default:
		writeJSON(w, http.StatusCreated, created)
	}
}

func (h *Handlers) GetRoom(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	got, err := h.Rooms.Get(r.Context(), id)
	switch {
	case errors.Is(err, room.ErrNotFound):
		notFound(w, "room_not_found")
	case err != nil:
		internalErr(w, h.Logger, err)
	default:
		writeJSON(w, http.StatusOK, got)
	}
}

func (h *Handlers) RoomMembers(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if _, err := h.Rooms.Get(r.Context(), id); err != nil { // 房间不存在 → 404
		if errors.Is(err, room.ErrNotFound) {
			notFound(w, "room_not_found")
			return
		}
		internalErr(w, h.Logger, err)
		return
	}
	members, err := h.Rooms.Members(r.Context(), id)
	if err != nil {
		internalErr(w, h.Logger, err)
		return
	}
	out := make([]chat.User, 0, len(members))
	for _, m := range members {
		out = append(out, chat.User{ID: m.ID, Name: m.Name})
	}
	writeJSON(w, http.StatusOK, map[string]any{"members": out})
}

func (h *Handlers) RoomMessages(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	limit, _ := strconv.ParseInt(r.URL.Query().Get("limit"), 10, 64)
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	msgs, err := h.Store.History(r.Context(), id, r.URL.Query().Get("before_seq"), limit)
	if err != nil {
		internalErr(w, h.Logger, err)
		return
	}
	out := make([]chat.Message, 0, len(msgs))
	for _, m := range msgs {
		out = append(out, m.ToMessage()) // store.Message 是 chat.Record 的别名
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"messages": out,
		"has_more": len(out) == int(limit),
	})
}
