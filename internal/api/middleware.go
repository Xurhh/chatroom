package api

import (
	"context"
	"net/http"
	"strings"

	"chatroom/internal/authn"
)

type ctxKey int

const ctxClaims ctxKey = iota

// AuthMiddleware 校验 Authorization: Bearer <jwt>，把 Claims 放进 context。
func AuthMiddleware(auth *authn.Service) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := r.Header.Get("Authorization")
			token, ok := strings.CutPrefix(h, "Bearer ")
			if !ok {
				unauthorized(w, "missing bearer token")
				return
			}
			claims, err := auth.Verify(token)
			if err != nil {
				unauthorized(w, "invalid or expired token")
				return
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxClaims, claims)))
		})
	}
}

// ClaimsFrom 从请求 context 取 JWT 载荷。
func ClaimsFrom(r *http.Request) *authn.Claims {
	c, _ := r.Context().Value(ctxClaims).(*authn.Claims)
	return c
}
