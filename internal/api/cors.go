package api

import (
	"net/http"
	"slices"
)

// CORS 让前端在 http://localhost:5173 等白名单源上直接调本地 8080（guide 8.2 的联调提示）。
//
// 生产同源部署（go:embed 前端，guide 8.4）时白名单可以只留正式域名。
func CORS(allowed []string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" && slices.Contains(allowed, origin) {
				h := w.Header()
				h.Set("Access-Control-Allow-Origin", origin)
				h.Add("Vary", "Origin")
				h.Set("Access-Control-Allow-Credentials", "true")
				h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
				h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
				h.Set("Access-Control-Max-Age", "600")
			}
			if r.Method == http.MethodOptions { // 预检请求直接放行
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
