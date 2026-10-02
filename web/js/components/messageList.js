/*!
 * js/components/messageList.js —— 中栏：消息流
 *
 * 负责三件容易出错的事：
 *   1. 增量渲染：只在尾部追加，避免每次 notify 全量重建（重建会丢滚动位置、闪屏）；
 *   2. 向上翻页保持位置：记录插入前的 scrollHeight，插入后把差值补回 scrollTop；
 *   3. 乐观消息三态：发送中（灰）/ 已发送 / 失败（点击重试，复用同一个 client_msg_id）。
 */
(function (global) {
  'use strict';

  const CR = (global.CR = global.CR || {});
  const components = (CR.components = CR.components || {});
  const doc = () => global.document;

  let onLoadMore = null;
  let onRetry = null;
  let renderedRoom = null;
  let renderedVersions = [];
  let renderedEmpty = false;
  let pendingPrependAdjust = false;
  let lastDay = '';

  function el(id) {
    return doc().getElementById(id);
  }

  /**
   * 一条消息的"渲染版本"。
   * 为什么不只用 key（seq / clientMsgId）：乐观消息的状态变化（发送中 → 已发送 / 失败）
   * 不会改变 key，只用 key 比较就会漏掉这些变化，界面会一直停在"发送中"。
   */
  function versionOf(item) {
    if (item.kind === 'message') return 'm:' + item.seq;
    if (item.kind === 'pending') return 'p:' + item.clientMsgId + ':' + (item.status || 'sending');
    return 'n:' + item.id;
  }

  function commonPrefix(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    return i;
  }

  function divider(ts) {
    const day = CR.util.formatDay(ts);
    if (day === lastDay) return null;
    lastDay = day;
    const node = doc().createElement('div');
    node.className = 'day-divider';
    node.textContent = day;
    return node;
  }

  function noticeNode(item) {
    const node = doc().createElement('div');
    node.className = 'notice';
    const text = doc().createElement('span');
    text.textContent = item.text;
    const time = doc().createElement('span');
    time.className = 'notice-time';
    time.textContent = CR.util.formatTime(item.ts);
    node.appendChild(text);
    node.appendChild(time);
    return node;
  }

  function messageNode(item, state) {
    const isPending = item.kind === 'pending';
    const me = state.session.user ? state.session.user.id : '';
    const fromId = (item.from && item.from.id) || (isPending ? me : '');
    const own = fromId === me;

    const wrap = doc().createElement('div');
    wrap.className = 'msg ' + (own ? 'msg-own' : 'msg-other');
    if (isPending) wrap.classList.add('msg-pending', 'msg-' + (item.status || 'sending'));
    if (item.seq) wrap.setAttribute('data-seq', item.seq);
    if (item.clientMsgId) wrap.setAttribute('data-cmid', item.clientMsgId);

    // 他人消息才显示昵称，自己的靠右不需要
    if (!own) {
      const who = doc().createElement('div');
      who.className = 'msg-who';
      who.textContent = (item.from && item.from.name) || '匿名';
      wrap.appendChild(who);
    }

    const bubble = doc().createElement('div');
    bubble.className = 'bubble';
    // textContent：用户输入永不进 innerHTML，天然免疫 XSS
    bubble.textContent = item.content;
    wrap.appendChild(bubble);

    const meta = doc().createElement('div');
    meta.className = 'msg-meta';
    const time = doc().createElement('span');
    time.className = 'msg-time';
    time.textContent = CR.util.formatTime(item.ts);
    meta.appendChild(time);
    wrap.appendChild(meta);

    if (isPending) {
      const status = doc().createElement('div');
      status.className = 'msg-status';
      if (item.status === 'failed') {
        const btn = doc().createElement('button');
        btn.type = 'button';
        btn.className = 'msg-retry';
        btn.setAttribute('data-cmid', item.clientMsgId);
        btn.textContent = '发送失败，点击重试';
        status.appendChild(btn);
      } else {
        status.textContent = item.status === 'sent' ? '已发送' : '发送中…';
      }
      wrap.appendChild(status);
    }
    return wrap;
  }

  /** 插入一条（必要时先插日期分隔条）。 */
  function appendItem(host, item, state) {
    const d = divider(item.ts);
    if (d) host.appendChild(d);
    host.appendChild(item.kind === 'notice' ? noticeNode(item) : messageNode(item, state));
  }

  /**
   * 把最后一条消息节点换成新版本（状态变化时用）。
   * 找不到消息节点（说明结构变了）就返回 false，交给调用方全量重建。
   */
  function replaceLastNode(host, item, state) {
    const nodes = host.children;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (node.classList && (node.classList.contains('msg') || node.classList.contains('notice'))) {
        node.remove();
        appendItem(host, item, state);
        return true;
      }
    }
    return false;
  }

  function skeleton() {
    const box = doc().createElement('div');
    box.className = 'skeleton-box';
    for (let i = 0; i < 3; i++) {
      const row = doc().createElement('div');
      row.className = 'skeleton ' + (i % 2 ? 'skeleton-right' : '');
      box.appendChild(row);
    }
    return box;
  }

  function emptyState() {
    const node = doc().createElement('div');
    node.className = 'empty';
    node.textContent = '还没有消息，打个招呼吧 👋';
    return node;
  }

  function renderTyping(state) {
    const tip = el('typing-indicator');
    if (!tip) return;
    const label = state.currentRoom ? CR.store.typingLabel(state.currentRoom) : '';
    if (label) {
      tip.hidden = false;
      tip.textContent = label;
    } else {
      tip.hidden = true;
      tip.textContent = '';
    }
  }

  components.messageList = {
    onLoadMore(fn) {
      onLoadMore = fn;
    },
    onRetry(fn) {
      onRetry = fn;
    },

    mount() {
      const host = el('message-list');
      if (host) {
        host.addEventListener('scroll', () => {
          if (!onLoadMore) return;
          const state = CR.store.state;
          const room = state.currentRoom;
          if (!room) return;
          if (host.scrollTop > 40) return;
          if (state.loadingMore[room]) return;
          if (state.hasMore[room] === false) return;
          if (!CR.store.messageCountFor(room)) return;
          const earliest = (state.messages[room] || [])[0];
          if (!earliest) return;
          pendingPrependAdjust = true;
          onLoadMore(room, earliest.seq);
        });

        host.addEventListener('click', (ev) => {
          const btn = ev.target && ev.target.closest ? ev.target.closest('.msg-retry') : null;
          if (btn && onRetry) onRetry(btn.getAttribute('data-cmid'));
        });
      }
    },

    /** 切换房间时由 main.js 调用，清掉增量渲染缓存。 */
    reset() {
      renderedRoom = null;
      renderedVersions = [];
      renderedEmpty = false;
      lastDay = '';
      pendingPrependAdjust = false;
      const host = el('message-list');
      if (host) host.textContent = '';
    },

    render(state) {
      renderTyping(state);
      const host = el('message-list');
      if (!host) return;

      const room = state.currentRoom;
      if (!room) {
        renderedRoom = null;
        renderedVersions = [];
        renderedEmpty = false;
        host.textContent = '';
        const tip = doc().createElement('div');
        tip.className = 'empty';
        tip.textContent = '从左侧选择一个房间开始聊天';
        host.appendChild(tip);
        return;
      }

      if (renderedRoom !== room) {
        host.textContent = '';
        renderedVersions = [];
        renderedEmpty = false;
        lastDay = '';
        renderedRoom = room;
      }

      const items = CR.store.timelineFor(room);
      const versions = items.map(versionOf);

      const beforeHeight = host.scrollHeight;
      const beforeTop = host.scrollTop;
      const atBottom = beforeHeight - beforeTop - host.clientHeight < 80;

      if (!items.length) {
        // 空态 / 骨架屏：只在状态真的变了的时候重建，避免每帧都闪
        const wantSkeleton = !!state.loadingMore[room];
        const currentIsSkeleton = host.querySelector('.skeleton-box') !== null;
        const needsRebuild = !renderedEmpty || wantSkeleton !== currentIsSkeleton;
        if (needsRebuild) {
          host.textContent = '';
          lastDay = '';
          host.appendChild(wantSkeleton ? skeleton() : emptyState());
        }
        renderedEmpty = true;
        renderedVersions = [];
        return;
      }

      // 从空态（"还没有消息" / 骨架）切到有消息：先把占位节点清掉
      if (renderedEmpty) {
        host.textContent = '';
        lastDay = '';
        renderedEmpty = false;
      }

      const common = commonPrefix(renderedVersions, versions);
      if (common === renderedVersions.length) {
        // 纯追加：只渲染尾部（common 就是已渲染的条数）
        for (let i = common; i < items.length; i++) appendItem(host, items[i], state);
      } else if (
        common === versions.length - 1 &&
        versions.length <= renderedVersions.length &&
        replaceLastNode(host, items[items.length - 1], state)
      ) {
        // 只有最后一条的状态变了（发送中 → 已发送 / 发送失败 / 重试中）：
        // 就地换掉这一个节点，比全量重建便宜得多，也不会让滚动位置跳。
      } else {
        // 中间有插入/替换（sync 补拉、乐观消息被替换）：全量重建
        host.textContent = '';
        lastDay = '';
        items.forEach((item) => appendItem(host, item, state));
      }
      renderedVersions = versions;

      if (pendingPrependAdjust) {
        // 向上翻页：把新插入内容的高度补进 scrollTop，视觉上"不跳动"
        host.scrollTop = beforeTop + (host.scrollHeight - beforeHeight);
        pendingPrependAdjust = false;
      } else if (atBottom || state.loadingMore[room]) {
        host.scrollTop = host.scrollHeight;
      }
    },

    /** 供 main.js 在"首次进入房间/加载完历史"后强制滚到底部。 */
    scrollToBottom() {
      const host = el('message-list');
      if (host) host.scrollTop = host.scrollHeight;
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);