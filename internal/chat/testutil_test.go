package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"go.uber.org/goleak"
)

// TestMain 给整个包挂上 goroutine 泄漏检测（guide 9.1 的关键纪律）。
func TestMain(m *testing.M) {
	goleak.VerifyTestMain(m)
}

var errFakeClosed = errors.New("fake conn closed")

// fakeConn 是 chat.Conn 的内存实现：读侧可注入数据，写侧记录下来。
//
// 这正是把 Conn 抽成接口的回报：Hub 的扇出、背压踢人、双泵退出路径
// 全都能在没有真实网络的情况下测（guide 9.1）。
type fakeConn struct {
	mu      sync.Mutex
	reads   chan []byte
	writes  [][]byte
	control [][]byte
	closed  chan struct{}
	once    sync.Once

	// blockWrites=true 时 WriteMessage 一直阻塞到连接关闭，
	// 用来模拟"写不出去"的慢消费者。
	blockWrites bool
}

func newFakeConn() *fakeConn {
	return &fakeConn{reads: make(chan []byte, 16), closed: make(chan struct{})}
}

func (f *fakeConn) ReadMessage() (int, []byte, error) {
	select {
	case <-f.closed:
		return 0, nil, errFakeClosed
	case b := <-f.reads:
		return websocket.TextMessage, b, nil
	}
}

func (f *fakeConn) WriteMessage(_ int, data []byte) error {
	if f.blockWrites {
		<-f.closed
		return errFakeClosed
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	select {
	case <-f.closed:
		return errFakeClosed
	default:
	}
	f.writes = append(f.writes, append([]byte(nil), data...))
	return nil
}

func (f *fakeConn) WriteControl(_ int, data []byte, _ time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.control = append(f.control, append([]byte(nil), data...))
	return nil
}

func (f *fakeConn) SetReadLimit(int64)                {}
func (f *fakeConn) SetReadDeadline(time.Time) error   { return nil }
func (f *fakeConn) SetWriteDeadline(time.Time) error  { return nil }
func (f *fakeConn) SetPongHandler(func(string) error) {}

func (f *fakeConn) Close() error {
	f.once.Do(func() { close(f.closed) })
	return nil
}

func (f *fakeConn) written() [][]byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([][]byte, len(f.writes))
	copy(out, f.writes)
	return out
}

func (f *fakeConn) closeFrames() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.control)
}

// ---------- 假存储（实现 chat.Backend，无需 Redis） ----------

type fakeBackend struct {
	mu        sync.Mutex
	appended  []Record
	since     []Record
	claimed   map[string]string
	published [][]byte
	leaves    []string // PresenceLeave 调用记录，格式 "room/user"

	// fanout 非空时，Publish 会模拟 Redis 把消息"回声"给订阅端，
	// 于是 M1 的"本地投递走 Pub/Sub"路径也能在单测里跑起来（guide 4.4）。
	fanout *fakeSubscriber

	failAppend bool
}

func newFakeBackend() *fakeBackend {
	return &fakeBackend{claimed: map[string]string{}}
}

func (f *fakeBackend) Append(_ context.Context, _ string, m Record) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failAppend {
		return "", errors.New("append failed")
	}
	f.appended = append(f.appended, m)
	return fmt.Sprintf("%d-0", len(f.appended)), nil
}

func (f *fakeBackend) Since(context.Context, string, string, int64) ([]Record, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.since, nil
}

func (f *fakeBackend) DedupClaim(_ context.Context, _, clientMsgID string) (bool, string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	seq, ok := f.claimed[clientMsgID]
	if ok {
		return false, seq, nil
	}
	f.claimed[clientMsgID] = "" // 占位，seq 待回填
	return true, "", nil
}

func (f *fakeBackend) DedupRecordSeq(_ context.Context, _, clientMsgID, seq string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.claimed[clientMsgID] = seq
	return nil
}

func (f *fakeBackend) DedupRelease(_ context.Context, _, clientMsgID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.claimed, clientMsgID)
	return nil
}

func (f *fakeBackend) PresenceJoin(context.Context, string, string, string) error { return nil }

func (f *fakeBackend) PresenceLeave(_ context.Context, roomID, userID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.leaves = append(f.leaves, roomID+"/"+userID)
	return nil
}

func (f *fakeBackend) presenceLeaves() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.leaves...)
}

func (f *fakeBackend) publishedPayloads() [][]byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([][]byte, 0, len(f.published))
	for _, b := range f.published {
		out = append(out, append([]byte(nil), b...))
	}
	return out
}

func (f *fakeBackend) PresenceMembers(context.Context, string) (map[string]string, error) {
	return map[string]string{}, nil
}

func (f *fakeBackend) Publish(_ context.Context, roomID string, payload []byte) error {
	f.mu.Lock()
	f.published = append(f.published, append([]byte(nil), payload...))
	fanout := f.fanout
	f.mu.Unlock()

	if fanout != nil { // 模拟 Redis 把这条消息投回订阅者
		fanout.push(roomID, payload)
	}
	return nil
}

func (f *fakeBackend) appends() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.appended)
}

func (f *fakeBackend) publishedTypes() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.published))
	for _, b := range f.published {
		var m map[string]any
		if json.Unmarshal(b, &m) == nil {
			out = append(out, fmt.Sprint(m["type"]))
		}
	}
	return out
}

// ---------- 假扇出订阅端（实现 chat.Subscriber） ----------

type fakeSubscriber struct {
	events chan Event
}

func newFakeSubscriber() *fakeSubscriber {
	return &fakeSubscriber{events: make(chan Event, 64)}
}

func (f *fakeSubscriber) Subscribe(context.Context, ...string) error   { return nil }
func (f *fakeSubscriber) Unsubscribe(context.Context, ...string) error { return nil }
func (f *fakeSubscriber) Channel() <-chan Event                        { return f.events }
func (f *fakeSubscriber) Close() error                                 { return nil }

func (f *fakeSubscriber) push(roomID string, payload []byte) {
	select {
	case f.events <- Event{RoomID: roomID, Payload: append([]byte(nil), payload...)}:
	default:
	}
}

// ---------- 轮询断言（避免依赖 sleep 的脆弱测试） ----------

func waitFor(t *testing.T, timeout time.Duration, cond func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s", what)
}

// waitEnvelope 等某个 type 的下行 envelope 出现在假连接的写出记录里。
func waitEnvelope(t *testing.T, c *fakeConn, wantType string, timeout time.Duration) map[string]any {
	t.Helper()
	var found map[string]any
	waitFor(t, timeout, func() bool {
		for _, b := range c.written() {
			var m map[string]any
			if json.Unmarshal(b, &m) != nil {
				continue
			}
			if m["type"] == wantType {
				found = m
				return true
			}
		}
		return false
	}, "envelope type="+wantType)
	return found
}

func countEnvelopes(c *fakeConn, wantType string) int {
	n := 0
	for _, b := range c.written() {
		var m map[string]any
		if json.Unmarshal(b, &m) == nil && m["type"] == wantType {
			n++
		}
	}
	return n
}
