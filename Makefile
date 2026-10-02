# chatroom 常用命令（guide 3/9/10 章的操作入口）
BINARY := bin/chat
PKG    := ./...

.PHONY: help build run test race vet fmt tidy up down logs redis smoke loadtest docker clean web webtest web-e2e web-dist

help:
	@grep -E '^[a-zA-Z_-]+:' $(MAKEFILE_LIST) | awk -F: '{printf "  make %-10s\n", $$1}'

## 编译到 bin/chat
build:
	go build -o $(BINARY) ./cmd/server

## 本地直接跑（前置：make up 起 Redis；默认监听 :8080，pprof :6060）
run:
	go run ./cmd/server

## 单测（含 goleak 泄漏检测）
test:
	go test $(PKG)

## 并发单测：guide 10 的必做项（-race 全绿）
race:
	go test -race -count=1 $(PKG)

## 静态检查
vet:
	go vet $(PKG)

fmt:
	gofmt -l -w .

tidy:
	go mod tidy

## ---- 本地依赖 ----
## 起 Redis（M1 起需要；M0 纯内存模式不需要）
up:
	docker compose -f deploy/docker-compose.yml up -d redis

down:
	docker compose -f deploy/docker-compose.yml down

logs:
	docker compose -f deploy/docker-compose.yml logs -f

redis:
	docker compose -f deploy/docker-compose.yml exec redis redis-cli

## ---- 冒烟 ----
## 注册 → 登录 → 房间列表（需要服务已启动）
smoke:
	@curl -s -X POST localhost:8080/api/v1/auth/register \
		-H 'Content-Type: application/json' \
		-d '{"username":"bob","password":"S3cret!pass"}' ; echo
	@curl -s -X POST localhost:8080/api/v1/auth/login \
		-H 'Content-Type: application/json' \
		-d '{"username":"bob","password":"S3cret!pass"}' ; echo
	@curl -s localhost:8080/healthz ; echo

## ---- 压测（需要 k6）----
## TOKEN=... WS_URL=ws://localhost:8080 k6 run loadtest/ws.js
loadtest:
	k6 run loadtest/ws.js

docker:
	docker build -f deploy/Dockerfile -t chat-server:dev .

## ---- 前端（web/，原生 HTML/CSS/JS，无需 npm）----
## 起静态服务器：端口必须是 5173，否则要同步改后端 ALLOWED_ORIGINS（CORS + WS CheckOrigin）
web:
	@echo "→ http://localhost:5173/  （Ctrl-C 停止）"
	python3 -m http.server 5173 --directory web

## 前端自动化测试（状态/契约/结构/连接重连，全部走 mock，不需要后端）
webtest:
	node --test web/test/*.test.mjs

## 前端 → 真后端端到端（前置：make up && make run）
web-e2e:
	CR_E2E=1 CR_API_BASE=http://localhost:8080 node web/test/e2e.mjs

## 产出 web/dist（给 guide 8.4 的 go:embed web/dist 用）
web-dist:
	rm -rf web/dist
	mkdir -p web/dist/js/components web/dist/css
	cp web/index.html web/dist/
	cp web/css/style.css web/dist/css/
	cp web/js/*.js web/dist/js/
	cp web/js/components/*.js web/dist/js/components/
	@echo "web/dist 已生成：$$(find web/dist -type f | wc -l) 个文件"

clean:
	rm -rf bin