// Package api REST handler 的公共辅助。
package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

// ErrorBody 统一错误响应：{"code": "...", "message": "..."}。
type ErrorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, ErrorBody{Code: code, Message: msg})
}

func badRequest(w http.ResponseWriter, msg string)     { writeError(w, http.StatusBadRequest, "bad_request", msg) }
func unauthorized(w http.ResponseWriter, msg string)   { writeError(w, http.StatusUnauthorized, "unauthorized", msg) }
func notFound(w http.ResponseWriter, code string)      { writeError(w, http.StatusNotFound, code, "not found") }
func internalErr(w http.ResponseWriter, logger *slog.Logger, err error) {
	logger.Error("internal error", "err", err)
	writeError(w, http.StatusInternalServerError, "internal", "internal error")
}

func decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		badRequest(w, "invalid json body")
		return false
	}
	return true
}
