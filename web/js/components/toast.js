/*!
 * js/components/toast.js —— 轻提示 + 断线横幅
 */
(function (global) {
  'use strict';

  const CR = (global.CR = global.CR || {});
  const components = (CR.components = CR.components || {});

  let lastToastId = 0;
  const timers = {};

  function el(id) {
    return global.document.getElementById(id);
  }

  function removeToast(id) {
    const host = el('toast-host');
    if (!host) return;
    const node = host.querySelector('[data-toast-id="' + id + '"]');
    if (node) {
      node.classList.add('toast-out');
      setTimeout(() => node.remove(), 180);
    }
  }

  function renderToast(state) {
    const toast = state.toast;
    if (!toast || toast.id === lastToastId) return;
    lastToastId = toast.id;
    const host = el('toast-host');
    if (!host) return;

    const node = global.document.createElement('div');
    node.className = 'toast toast-' + (toast.kind || 'info');
    node.setAttribute('data-toast-id', String(toast.id));
    node.textContent = toast.text;
    host.appendChild(node);

    const id = toast.id;
    timers[id] = setTimeout(() => {
      removeToast(id);
      delete timers[id];
      // 让 store 里的 toast 也过期，避免下次 notify 又把它画回来
      if (CR.store.state.toast && CR.store.state.toast.id === id) CR.store.clearToast(id);
    }, toast.kind === 'error' ? 5200 : 3200);
  }

  function renderBanner(state) {
    const banner = el('conn-banner');
    if (!banner) return;
    const conn = state.conn || {};
    let text = '';
    let kind = '';

    if (conn.status === 'offline') {
      kind = 'warn';
      text = '连接已断开，正在重连（第 ' + Math.max(1, conn.retry || 1) + ' 次）…';
    } else if (conn.status === 'connecting') {
      kind = 'info';
      text = '正在连接服务器…';
    } else if (conn.status === 'unauthorized') {
      kind = 'error';
      text = '登录已失效，请重新登录';
    }

    if (!text) {
      banner.hidden = true;
      banner.textContent = '';
      banner.className = 'banner';
      return;
    }
    banner.hidden = false;
    banner.className = 'banner banner-' + kind;
    banner.textContent = text;
  }

  components.toast = {
    render(state) {
      renderToast(state);
      renderBanner(state);
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);