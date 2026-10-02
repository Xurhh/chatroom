/*!
 * test/structure.test.mjs —— 工程约束的自动化检查
 *
 * guide 8.2 里有几条硬约束，靠人眼 review 很容易漏，这里用测试钉死：
 *   - 文件结构固定（index.html / css / js 八个文件 / components 四个）
 *   - fetch 只允许出现在 js/api.js，new WebSocket 只允许出现在 js/ws.js
 *   - 不用 ES Module、不用框架、不用打包器（双击 file:// 也能跑）
 *   - index.html 引用的每个文件都存在，且 js 目录里没有"写了但没被引用"的死文件
 *   - JS 里用到的每个元素 id，index.html 里都真的存在（防手滑改错名字）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { WEB_ROOT } from './harness.mjs';

const REQUIRED = [
  'index.html',
  'css/style.css',
  'js/config.js',
  'js/api.js',
  'js/ws.js',
  'js/mock.js',
  'js/store.js',
  'js/components/roomList.js',
  'js/components/messageList.js',
  'js/components/memberList.js',
  'js/components/toast.js',
  'js/main.js',
  'README.md',
];

function read(rel) {
  return fs.readFileSync(path.join(WEB_ROOT, rel), 'utf8');
}

function listJsFiles() {
  const out = [];
  const walk = (dir) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'test' || entry.name === 'node_modules') return;
        walk(full);
      } else if (entry.name.endsWith('.js')) {
        out.push(path.relative(WEB_ROOT, full));
      }
    });
  };
  walk(path.join(WEB_ROOT, 'js'));
  return out;
}

test('文件结构齐全（guide 8.2 规定的那些文件都在）', () => {
  REQUIRED.forEach((rel) => {
    assert.ok(fs.existsSync(path.join(WEB_ROOT, rel)), '缺少文件: ' + rel);
  });
});

test('fetch 只出现在 js/api.js；new WebSocket 只出现在 js/ws.js', () => {
  const offenders = [];
  listJsFiles().forEach((rel) => {
    const code = read(rel);
    if (/\bfetch\s*\(/.test(code) && rel !== 'js/api.js') offenders.push(rel + ' 使用了 fetch');
    if (/new\s+(global\.)?WebSocket\s*\(/.test(code) && rel !== 'js/ws.js') {
      offenders.push(rel + ' 使用了 new WebSocket');
    }
  });
  assert.deepEqual(offenders, [], '网络交互必须集中在 api.js / ws.js');
  assert.match(read('js/api.js'), /\bfetch\s*\(/, 'api.js 里应该有 fetch');
  assert.match(read('js/ws.js'), /new\s+(global\.)?WebSocket\s*\(/, 'ws.js 里应该有 new WebSocket');
});

test('不使用 ES Module / 框架 / 打包器（保证双击 file:// 可运行）', () => {
  const html = read('index.html');
  assert.ok(!/type\s*=\s*["']module["']/.test(html), 'index.html 不能使用 type="module"');

  listJsFiles().forEach((rel) => {
    const code = read(rel);
    assert.ok(!/^\s*import\s+[\w{*"']/m.test(code), rel + ' 出现了 ES import');
    assert.ok(!/^\s*export\s+[\w{*"']/m.test(code), rel + ' 出现了 ES export');
  });

  ['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'vite.config.js', 'webpack.config.js', 'tsconfig.json', 'node_modules'].forEach(
    (artifact) => {
      assert.ok(!fs.existsSync(path.join(WEB_ROOT, artifact)), '不该出现构建工具产物: ' + artifact);
    }
  );
});

test('所有 JS 文件语法正确（能被 JS 引擎解析）', () => {
  listJsFiles().forEach((rel) => {
    const code = read(rel);
    assert.doesNotThrow(() => new vm.Script(code, { filename: rel }), rel + ' 语法错误');
  });
});

test('index.html 按依赖顺序引入脚本，且引用的文件都存在', () => {
  const html = read('index.html');
  const scripts = Array.from(html.matchAll(/<script\s+src="([^"]+)"/g)).map((m) => m[1]);
  const css = Array.from(html.matchAll(/<link[^>]+href="([^"]+)"/g)).map((m) => m[1]);

  const expectedOrder = [
    'js/config.js',
    'js/store.js',
    'js/mock.js',
    'js/api.js',
    'js/ws.js',
    'js/components/toast.js',
    'js/components/roomList.js',
    'js/components/messageList.js',
    'js/components/memberList.js',
    'js/main.js',
  ];
  assert.deepEqual(scripts, expectedOrder, '脚本顺序有依赖：config → store → mock → api → ws → 组件 → main');
  assert.deepEqual(css, ['css/style.css']);

  scripts.concat(css).forEach((rel) => {
    assert.ok(fs.existsSync(path.join(WEB_ROOT, rel)), 'index.html 引用了不存在的文件: ' + rel);
  });
});

test('js 目录下没有"写了却没被 index.html 引用"的死文件', () => {
  const html = read('index.html');
  const referenced = new Set(Array.from(html.matchAll(/src="([^"]+)"/g)).map((m) => m[1]));
  const dead = listJsFiles().filter((rel) => !referenced.has(rel));
  assert.deepEqual(dead, [], '这些文件没有被引入：' + dead.join(', '));
});

test('JS 里用到的元素 id 都存在于 index.html', () => {
  const html = read('index.html');
  const ids = new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g)).map((m) => m[1]));

  const missing = new Map();
  listJsFiles()
    .concat(['js/components/toast.js'])
    .forEach((rel) => {
      const code = read(rel);
      const used = new Set();
      Array.from(code.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)).forEach((m) => used.add(m[1]));
      Array.from(code.matchAll(/\bel\(\s*'([^']+)'\s*\)/g)).forEach((m) => used.add(m[1]));
      used.forEach((id) => {
        if (!ids.has(id)) missing.set(id, rel);
      });
    });
  assert.deepEqual(
    Array.from(missing.entries()),
    [],
    'JS 引用了 html 里不存在的 id：' + Array.from(missing.entries()).map(([i, f]) => i + '(' + f + ')').join(', ')
  );
});

test('index.html 里没有内联的网络调用（保持"只读 UI"）', () => {
  const html = read('index.html');
  assert.ok(!/\bfetch\s*\(/.test(html), 'index.html 不该出现 fetch');
  assert.ok(!/new\s+WebSocket\s*\(/.test(html), 'index.html 不该出现 new WebSocket');
});

test('mock 工具按钮标记了 .mock-only（非 mock 模式要隐藏）', () => {
  const html = read('index.html');
  const mockOnly = Array.from(html.matchAll(/id="(btn-(?:simulate-drop|demo-other))"[^>]*/g));
  assert.equal(mockOnly.length, 2, '应该有"模拟断线"和"其它房间来消息"两个演示按钮');
  assert.match(read('js/main.js'), /querySelectorAll\('\.mock-only'\)/, 'main.js 要根据 MOCK 决定是否隐藏');
});