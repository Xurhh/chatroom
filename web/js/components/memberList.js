/*!
 * js/components/memberList.js —— 右栏：当前房间在线成员
 *
 * presence 事件（joins/leaves）由 main.js 交给 store，这里只负责画。
 */
(function (global) {
  'use strict';

  const CR = (global.CR = global.CR || {});
  const components = (CR.components = CR.components || {});
  const doc = () => global.document;

  let lastSignature = '';

  function el(id) {
    return doc().getElementById(id);
  }

  components.memberList = {
    render(state) {
      const list = el('member-list');
      const count = el('member-count');
      if (!list) return;

      const room = state.currentRoom;
      const members = room ? CR.store.membersFor(room) : [];
      const me = state.session.user ? state.session.user.id : '';
      const sig = room + '|' + members.map((m) => m.id + ':' + m.name).join(',');
      if (count) count.textContent = members.length ? String(members.length) : '';
      if (sig === lastSignature) return;
      lastSignature = sig;

      list.textContent = '';
      if (!room) return;
      if (!members.length) {
        const empty = doc().createElement('li');
        empty.className = 'empty small';
        empty.textContent = '暂时没有人在线';
        list.appendChild(empty);
        return;
      }

      members.forEach((m) => {
        const li = doc().createElement('li');
        li.className = 'member-item';
        const dot = doc().createElement('span');
        dot.className = 'dot';
        const name = doc().createElement('span');
        name.className = 'member-name';
        name.textContent = m.name || m.id;
        li.appendChild(dot);
        li.appendChild(name);
        if (m.id === me) {
          const tag = doc().createElement('span');
          tag.className = 'muted small';
          tag.textContent = '（我）';
          li.appendChild(tag);
        }
        list.appendChild(li);
      });
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);