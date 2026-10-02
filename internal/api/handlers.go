package api

import (
	"log/slog"
	"net/http"
	"strconv"
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
	Logger *slog.Logger
	// M0 先用内存用户表占位，后续替换为 DB。
	users map[string]userRecord
}

type userRecord struct {
	ID       string
	Name     string
	Password string // TODO: bcrypt 哈希
}

func NewHandlers(auth *authn.Service, st *store.Store, logger *slog.Logger) *Handlers {
	return &Handlers{Auth: auth, Store: st, Logger: logger, users: make(map[string]userRecord)}
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
	u, ok := h.users[req.Username]
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
	// TODO: 游标分页，从 Redis meta 集合读取。M0 占位返回空列表。
	writeJSON(w, http.StatusOK, map[string]any{
		"rooms":       []room.Room{},
		"next_cursor": "",
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
	// TODO: 写入 Redis meta Hash。
	writeJSON(w, http.StatusCreated, room.Room{
		ID:   "r_" + uuid.NewString()[:8],
		Name: req.Name,
	})
}

func (h *Handlers) GetRoom(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	// TODO: 读 Redis meta。
	writeJSON(w, http.StatusOK, room.Room{ID: id, Name: id})
}

func (h *Handlers) RoomMembers(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	members, err := h.Store.PresenceMembers(r.Context(), id)
	if err != nil {
		internalErr(w, h.Logger, err)
		return
	}
	out := make([]chat.User, 0, len(members))
	for uid, name := range members {
		out = append(out, chat.User{ID: uid, Name: name})
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
		out = append(out, chat.Message{
			Seq:     m.Seq,
			From:    &chat.User{ID: m.UserID, Name: m.Name},
			Content: m.Content,
			TS:      m.TS,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"messages": out,
		"has_more": len(out) == int(limit),
	})
}
