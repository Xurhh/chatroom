/*!
 * test/dom.mjs —— 一个"够用就好"的 DOM 垫片
 *
 * 目的：让 components/*.js 和 main.js（真正操作 DOM 的那一层）也能在 Node 里跑起来，
 * 从而把"双击打开 → 登录 → 渲染 → 发消息 → 切房间"这条链路上的低级错误挡住
 * （元素 id 写错、事件绑定漏了、渲染函数抛异常…），这些靠纯逻辑测试是发现不了的。
 *
 * 支持的能力刻意只做到项目用到的那一档：
 *   - 用正则解析 index.html 建出元素树（含 id 索引），足够让 getElementById 正常工作
 *   - createElement / appendChild / textContent / className / classList / setAttribute
 *   - querySelector(All) 支持 .class、#id、[attr="v"]、tag 这几种简单选择器
 *   - closest / addEventListener + 冒泡式 dispatchEvent
 * 它不是浏览器，跑不了样式和布局，所以"视觉/布局"仍然需要人眼过一遍。
 */
import fs from 'node:fs';
import path from 'node:path';

const VOID_TAGS = new Set(['meta', 'link', 'br', 'hr', 'img', 'input', 'source']);

class ClassList {
  constructor(el) {
    this.el = el;
  }
  _set() {
    const raw = this.el._className || '';
    return new Set(raw.split(/\s+/).filter(Boolean));
  }
  _write(set) {
    this.el._className = Array.from(set).join(' ');
  }
  contains(name) {
    return this._set().has(name);
  }
  add(...names) {
    const set = this._set();
    names.forEach((n) => set.add(n));
    this._write(set);
  }
  remove(...names) {
    const set = this._set();
    names.forEach((n) => set.delete(n));
    this._write(set);
  }
  toggle(name, force) {
    const set = this._set();
    const on = force === undefined ? !set.has(name) : !!force;
    if (on) set.add(name);
    else set.delete(name);
    this._write(set);
    return on;
  }
  get length() {
    return this._set().size;
  }
}

export class FakeElement {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.type = '';
    this.id = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this._className = '';
    this._listeners = {};
    this.classList = new ClassList(this);
  }

  get className() {
    return this._className;
  }
  set className(v) {
    this._className = String(v == null ? '' : v);
  }

  get children() {
    return this.childNodes.filter((n) => n instanceof FakeElement);
  }

  get textContent() {
    return this.childNodes
      .map((n) => (n instanceof FakeElement ? n.textContent : String(n)))
      .join('');
  }
  set textContent(v) {
    this.childNodes = [];
    if (v !== '' && v !== null && v !== undefined) this.childNodes.push(String(v));
  }

  appendChild(node) {
    if (node === null || node === undefined) return node;
    if (node instanceof FakeElement) node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.childNodes.indexOf(this);
    if (i >= 0) this.parentNode.childNodes.splice(i, 1);
    this.parentNode = null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = value;
    if (name === 'id') this.id = String(value);
    if (name === 'hidden') this.hidden = true;
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._listeners[type] || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  /** 触发事件并按 DOM 语义向上冒泡（document 上的监听器也会被调到）。 */
  dispatchEvent(type, extra) {
    const ev = Object.assign(
      {
        type,
        target: this,
        preventDefault() {},
        stopPropagation() {},
      },
      extra
    );
    let node = this;
    while (node) {
      (node._listeners[type] || []).slice().forEach((fn) => fn(ev));
      node = node.parentNode;
    }
    const doc = this.ownerDocument;
    if (doc) (doc._listeners[type] || []).slice().forEach((fn) => fn(ev));
    return ev;
  }

  closest(selector) {
    let node = this;
    while (node) {
      if (node instanceof FakeElement && matches(node, selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      node.children.forEach((child) => {
        if (matches(child, selector)) out.push(child);
        walk(child);
      });
    };
    walk(this);
    return out;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  focus() {}
  blur() {}
  click() {
    this.dispatchEvent('click');
  }
}

function matches(node, selector) {
  const sel = String(selector).trim();
  if (!sel) return false;

  // [attr="value"]
  const attr = sel.match(/^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'))?\]$/);
  if (attr) {
    const has = Object.prototype.hasOwnProperty.call(node.attributes, attr[1]);
    if (!has) return false;
    if (attr[2] === undefined && attr[3] === undefined) return true;
    return node.attributes[attr[1]] === (attr[2] !== undefined ? attr[2] : attr[3]);
  }
  // .class
  if (sel.startsWith('.')) return node.classList.contains(sel.slice(1));
  // #id
  if (sel.startsWith('#')) return node.id === sel.slice(1);
  // tag
  return node.tagName === sel.toUpperCase();
}

/** 极简 HTML 解析：只处理本项目这种规规矩矩的标签结构。 */
function parseHTML(html, doc) {
  const root = new FakeElement('html', doc);
  root.id = '';
  const stack = [root];
  const ids = new Map();
  const re = /<!--[\s\S]*?-->|<!\[[\s\S]*?\]>|<!DOCTYPE[^>]*>|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z0-9]+)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+)/gi;
  let skipUntil = null;
  let m;
  while ((m = re.exec(html)) !== null) {
    const [full, closeTag, openTag, rawAttrs, text] = m;
    if (full.startsWith('<!')) continue;
    if (skipUntil) {
      if (closeTag && closeTag.toLowerCase() === skipUntil) skipUntil = null;
      continue;
    }
    if (closeTag) {
      const name = closeTag.toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === name.toUpperCase()) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    if (openTag) {
      const el = new FakeElement(openTag, doc);
      const attrs = rawAttrs || '';
      const attrRe = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
      let a;
      while ((a = attrRe.exec(attrs)) !== null) {
        if (!a[1]) continue;
        const value = a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : '';
        el.setAttribute(a[1], value === undefined ? '' : value);
      }
      if (el.id) ids.set(el.id, el);
      stack[stack.length - 1].appendChild(el);
      const name = openTag.toLowerCase();
      if (!VOID_TAGS.has(name) && !full.endsWith('/>')) {
        stack.push(el);
        if (name === 'script' || name === 'style') skipUntil = name;
      }
      continue;
    }
    if (text && text.trim()) {
      stack[stack.length - 1].appendChild(text);
    }
  }
  return { root, ids };
}

/** 造一个 document（从 index.html 解析出来）。 */
export function createDocument(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const doc = {
    _listeners: {},
    readyState: 'complete',
    visibilityState: 'visible', // 真实浏览器一定有；main.js 的 visibilitychange 依赖它
    title: '',
    addEventListener(type, fn) {
      (doc._listeners[type] = doc._listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const list = doc._listeners[type] || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    dispatchEvent(type, extra) {
      const ev = Object.assign({ type, target: doc, preventDefault() {}, stopPropagation() {} }, extra);
      (doc._listeners[type] || []).slice().forEach((fn) => fn(ev));
    },
  };
  const { root, ids } = parseHTML(html, doc);
  const htmlEl = root.children[0] || root;
  const body = htmlEl.querySelector('body') || new FakeElement('body', doc);
  doc.documentElement = htmlEl;
  doc.body = body;
  doc.createElement = (tag) => new FakeElement(tag, doc);
  doc.getElementById = (id) => ids.get(id) || null;
  doc.querySelector = (sel) => root.querySelector(sel);
  doc.querySelectorAll = (sel) => root.querySelectorAll(sel);
  doc._ids = ids;
  doc._root = root;
  return doc;
}

export function indexPath() {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'index.html');
}