/*!
 * js/components/roomList.js —— 左栏：房间列表（含未读角标）
 */
(function (global) {
  'use strict';

  const CR = (global.CR = global.CR || {});
  const components = (CR.components = CR.components || {});
  const doc = () => global.document;

  let onSelect = null;
  let lastSignature = '';

  function el(id) {
    return doc().getElementById(id);
  }

  function makeItem(state, room) {
    const li = doc().createElement('li');
    li.className = 'room-item' + (room.id === state.currentRoom ? ' active' : '');
    li.setAttribute('data-room', room.id);
    li.setAttribute('role', 'button');
    li.tabIndex = 0;

    const name = doc().createElement('span');
    name.className = 'room-item-name';
    name.textContent = room.name || room.id;
    li.appendChild(name);

    const unread = CR.store.unreadFor(room.id);
    if (unread > 0) {
      const badge = doc().createElement('span');
      badge.className = 'badge';
      badge.textContent = unread > 99 ? '99+' : String(unread);
      li.appendChild(badge);
    } else {
      const count = doc().createElement('span');
      count.className = 'muted small';
      count.textContent = (room.member_count || 0) + ' 人';
      li.appendChild(count);
    }
    return li;
  }

  function signature(state) {
    return (
      state.currentRoom +
      '|' +
      state.rooms
        .map((r) => r.id + ':' + r.name + ':' + (r.member_count || 0) + ':' + CR.store.unreadFor(r.id))
        .join(',')
    );
  }

  components.roomList = {
    onSelect(fn) {
      onSelect = fn;
    },

    /** main.js 启动时调用一次：事件委托绑定。 */
    mount() {
      const list = el('room-list');
      if (!list) return;
      const pick = (target) => {
        const li = target && target.closest ? target.closest('.room-item') : null;
        if (li && onSelect) onSelect(li.getAttribute('data-room'));
      };
      list.addEventListener('click', (ev) => pick(ev.target));
      list.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          pick(ev.target);
        }
      });
    },

    render(state) {
      const list = el('room-list');
      if (!list) return;
      const sig = signature(state);
      if (sig === lastSignature) return; // 避免无谓重建（否则滚动位置会跳）
      lastSignature = sig;

      list.textContent = '';
      if (!state.rooms.length) {
        const empty = doc().createElement('li');
        empty.className = 'empty small';
        empty.textContent = '还没有房间，点右上角新建一个';
        list.appendChild(empty);
        return;
      }
      state.rooms.forEach((room) => list.appendChild(makeItem(state, room)));
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);