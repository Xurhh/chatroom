/*!
 * js/api.js —— 所有 HTTP 请求的唯一出口（fetch 只允许出现在这个文件里）
 *
 * 契约（guide 5.3 / 8.2，字段名一字不差）：
 *   POST /auth/register  {username,password}                     → 201 {user_id, created_at}
 *   POST /auth/login     {username,password}                     → 200 {token, expires_at, user:{id,name}}
 *   GET  /users/me                                               → 200 {id, name}
 *   GET  /rooms?cursor=&limit=                                    → 200 {rooms:[{id,name,member_count}], next_cursor}
 *   POST /rooms          {name}                                  → 201 {id, name, member_count}
 *   GET  /rooms/{id}                                             → 200 {id, name, member_count}
 *   GET  /rooms/{id}/members                                     → 200 {members:[{id,name}]}
 *   GET  /rooms/{id}/messages?before_seq=&limit=                  → 200 {messages:[...倒序], has_more}
 *
 * 错误统一为 {code, message}；401 表示 token 失效 → 回调 onUnauthorized（由 main.js 清登录态回登录页）。
 * MOCK=true 时全部转发给 mock.js 的内存实现，对外行为保持一致。
 */
(function (global) {
  'use strict';

  const CR = (global.CR = global.CR || {});

  let token = '';
  let onUnauthorized = null;

  function isMock() {
    return !!CR.config.MOCK;
  }

  function apiBase() {
    return CR.config.API_BASE.replace(/\/+$/, '') + '/api/v1';
  }

  function buildQuery(params) {
    if (!params) return '';
    const parts = [];
    Object.keys(params).forEach((k) => {
      const v = params[k];
      if (v === undefined || v === null || v === '') return;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  function makeError(status, code, message) {
    const err = new Error(message || code || 'request failed');
    err.status = status;
    err.code = code || 'error';
    return err;
  }

  function handleUnauthorized(err) {
    if (typeof onUnauthorized === 'function') {
      try {
        onUnauthorized(err);
      } catch (e) {
        console.error('[api] onUnauthorized error', e);
      }
    }
  }

  /**
   * 唯一的 fetch 调用点。
   * @param {string} method
   * @param {string} path     形如 '/rooms'
   * @param {object} [opts]   {body, query, auth}
   */
  function request(method, path, opts) {
    const o = opts || {};
    const headers = {};
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    if (o.auth !== false && token) headers['Authorization'] = 'Bearer ' + token;

    return global
      .fetch(apiBase() + path + buildQuery(o.query), {
        method,
        headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
      })
      .catch((e) => {
        // 网络层失败（后端没起、跨域被拦、断网）
        throw makeError(0, 'network_error', '网络错误：' + (e && e.message ? e.message : '请求失败'));
      })
      .then((res) =>
        res
          .text()
          .then((text) => ({ res, text }))
          .catch(() => ({ res, text: '' }))
      )
      .then(({ res, text }) => {
        let data = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch (e) {
            data = null;
          }
        }
        if (!res.ok) {
          const code = data && data.code ? data.code : 'http_' + res.status;
          const message =
            (data && data.message) ||
            (res.status === 401
              ? '登录已失效，请重新登录'
              : res.status === 404
              ? '资源不存在'
              : '请求失败（HTTP ' + res.status + '）');
          const err = makeError(res.status, code, message);
          // 只有"带鉴权的请求"收到 401 才算登录失效；
          // 登录接口自己返回 401（密码错）不能触发"清登录态"。
          if (res.status === 401 && o.auth !== false) handleUnauthorized(err);
          throw err;
        }
        return data;
      });
  }

  // ------------------------------------------------------------ mock 转发

  function viaMock(name, args) {
    const impl = CR.mock && CR.mock.api && CR.mock.api[name];
    if (!impl) return Promise.reject(makeError(0, 'mock_missing', 'mock 未实现：' + name));
    return impl.apply(null, args);
  }

  const api = {
    /** 设置/清除当前 token（登录成功后由 main.js 调用）。 */
    setToken(t) {
      token = t || '';
    },

    getToken() {
      return token;
    },

    /** 注册 onUnauthorized 回调（HTTP 401 时触发）。 */
    setOnUnauthorized(fn) {
      onUnauthorized = fn;
    },

    isMock,

    register(username, password) {
      if (isMock()) return viaMock('register', [username, password]);
      return request('POST', '/auth/register', { body: { username, password }, auth: false });
    },

    login(username, password) {
      if (isMock()) return viaMock('login', [username, password]);
      return request('POST', '/auth/login', { body: { username, password }, auth: false });
    },

    me() {
      if (isMock()) return viaMock('me', [token]);
      return request('GET', '/users/me');
    },

    listRooms(params) {
      const p = params || {};
      if (isMock()) return viaMock('listRooms', [token, p]);
      return request('GET', '/rooms', { query: { cursor: p.cursor, limit: p.limit } });
    },

    createRoom(name) {
      if (isMock()) return viaMock('createRoom', [token, name]);
      return request('POST', '/rooms', { body: { name } });
    },

    getRoom(id) {
      if (isMock()) return viaMock('getRoom', [token, id]);
      return request('GET', '/rooms/' + encodeURIComponent(id));
    },

    roomMembers(id) {
      if (isMock()) return viaMock('roomMembers', [token, id]);
      return request('GET', '/rooms/' + encodeURIComponent(id) + '/members');
    },

    roomMessages(id, params) {
      const p = params || {};
      if (isMock()) return viaMock('roomMessages', [token, id, p]);
      return request('GET', '/rooms/' + encodeURIComponent(id) + '/messages', {
        query: { before_seq: p.beforeSeq, limit: p.limit || CR.config.PAGE_SIZE },
      });
    },
  };

  CR.api = api;
})(typeof window !== 'undefined' ? window : globalThis);