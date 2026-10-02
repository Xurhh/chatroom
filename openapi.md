# Chatroom 接口文档

本文档内容与 `guide.md` 第 5 章保持一致，实现时以 guide.md §5.1–5.5 为准：

- 通用约定（认证、错误码、分页）：§5.1
- REST 端点一览：§5.2
- 核心接口详情（register / login / rooms / messages / members）：§5.3
- WebSocket 协议（C→S / S→C envelope）：§5.4
- WS 关闭码与错误码：§5.5

> 代码侧对应的协议模型见 `internal/chat/protocol.go`。
