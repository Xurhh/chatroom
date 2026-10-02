# 构建阶段：镜像 tag 必须跟 go.mod 的 go 指令保持一致（当前 1.26.x）
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /bin/chat ./cmd/server

# 运行阶段：distroless 里没有 shell（所以优雅关停放在进程内实现，不能用 preStop exec sleep，guide 7.4）
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /bin/chat /chat
EXPOSE 8080
ENTRYPOINT ["/chat"]
