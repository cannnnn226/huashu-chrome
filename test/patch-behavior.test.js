// 本地补丁开关的行为验证 —— 需要真的 Chrome 和装好的扩展，不进 `npm test`。
//
// 静态断言只能证明「代码里有个判断」，证明不了「关掉开关真的会停」。
// 这里用扩展自己的 patch 入口逐个拨开关，再看真实行为变没变：
//
//   标签页回收  数页数（不打扰用户）
//   前台保护    点一个 target=_blank 链接，看 Chrome 有没有把子页切到前台
//   前台诊断    切一次标签，看诊断日志最后一条记的是不是那一页
//
// 后两项会切前台、会动用户的窗口。只在用户明确授权时跑。
//
// 跑法：npm run test:patch（Chrome 开着、扩展连着）

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeClient } from '../src/lib/rpc.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const PORT = 8125;   // 避开 scenarios.test.js 的 8124
const TAG = 'swtest';   // 每个用例再加自己的后缀，见 nextTag()
const CAP = 6;       // 和 background.js 的 TAB_CAP 保持一致

let c;
let server;
// 本次测试开过的所有页面，收尾统一关掉——测试不能给用户的标签栏留垃圾
const opened = [];

const setSwitch = (key, on) => c.call('tabs', { action: 'patch', key, on });
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

let tagSeq = 0;
const nextTag = () => `${TAG}${++tagSeq}`;

async function openMany(n) {
  const tag = nextTag();
  const ids = [];
  for (let i = 1; i <= n; i++) {
    const r = await c.call('tabs', { action: 'new', url: `https://example.com/?${tag}=${i}-${Date.now()}`, label: `${tag}-${i}` });
    ids.push(r.tabId);
    opened.push(r.tabId);
    await sleep(600);
  }
  await sleep(1200);
  return { ids, tag };
}

async function aliveOf(tag) {
  const l = await c.call('tabs', { action: 'list' });
  const head = l.text.split('最近的前台切换')[0];
  return head.split('\n').filter((x) => x.includes(`${tag}-`)).length;
}

async function closeTabs(ids) {
  for (const id of ids) await c.call('tabs', { action: 'close', tabId: id }).catch(() => {});
}

// 诊断日志最后一条记的 tabId。没有记录返回 null
async function lastFrontLogTab() {
  const l = await c.call('tabs', { action: 'list' });
  const tail = l.text.split('最近的前台切换')[1] || '';
  const hits = [...tail.matchAll(/→ \[(\d+)\]/g)];
  return hits.length ? Number(hits[hits.length - 1][1]) : null;
}

before(async () => {
  server = http.createServer((req, res) => {
    const name = (req.url || '/').split('?')[0].replace(/^\//, '') || 'newtab.html';
    fs.readFile(path.join(DIR, name), (e, b) => {
      if (e) { res.writeHead(404); return res.end('nope'); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(b);
    });
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  c = new BridgeClient({ client: 'patch-behavior' });
  await c.connect();
  if (!c.extensionOnline) throw new Error('扩展没连上，这套测试跑不了');
});

after(async () => {
  // 先关掉本次测试开过的所有页，再恢复开关
  for (const id of new Set(opened)) await c?.call('tabs', { action: 'close', tabId: id }).catch(() => {});
  // 无论成败都把开关恢复默认，别把用户的浏览器留在奇怪状态
  for (const key of ['localPatchEnabled', 'patchReclaim', 'patchFrontGuard', 'patchFrontLog']) {
    await setSwitch(key, true).catch(() => {});
  }
  c?.close();
  server?.close();
});

test('回收开着：开 7 个只剩 6 个', async () => {
  await setSwitch('patchReclaim', true);
  const { ids, tag } = await openMany(7);
  const alive = await aliveOf(tag);
  await closeTabs(ids);
  assert.equal(alive, CAP, `开了 7 个，期望剩 ${CAP} 个，实际 ${alive} 个`);
});

test('回收关着：开 7 个全部留着', async () => {
  await setSwitch('patchReclaim', false);
  const { ids, tag } = await openMany(7);
  const alive = await aliveOf(tag);
  await closeTabs(ids);
  assert.equal(alive, 7, `关掉回收后开了 7 个，期望 7 个都留着，实际 ${alive} 个`);
});

test('总开关关掉时，分开关开着也不生效', async () => {
  await setSwitch('patchReclaim', true);
  await setSwitch('localPatchEnabled', false);
  const { ids, tag } = await openMany(7);
  const alive = await aliveOf(tag);
  await closeTabs(ids);
  assert.equal(alive, 7, `总开关关掉后开了 7 个，期望 7 个都留着，实际 ${alive} 个`);
  await setSwitch('localPatchEnabled', true);
});

// 前台保护有没有生效，看页面里有没有被装上 window.open 的替换。
//
// 不测「子页会不会被切到前台」：测试用的是扩展注入的点击，Chrome 不认成用户手势，
// 关掉保护也不会激活新页，那个前提在自动化环境里不成立。
// 但 pageOpenShim 注入在页面主世界，装没装上能直接读到——这才是开关真正控制的东西。
async function shimInstalled() {
  const res = await c.call('tabs', { action: 'new', url: `http://127.0.0.1:${PORT}/newtab.html` });
  const tabId = res.tabId;
  opened.push(tabId);
  await sleep(700);
  const snap = await c.call('snapshot', {}, { tabId });
  const m = /\[(e\d+)\]\s+button\s+"点了什么都不开"/.exec(snap.text);
  assert.ok(m, '靶场里找不到对照按钮');
  // 做一次动作：注入发生在每条动作之前
  await c.call('click', { ref: m[1] }, { tabId });
  await sleep(400);
  const r = await c.call('eval', { expr: 'String(window.__hcOpenHooked === true)' }, { tabId });
  const on = /true/.test(r.text.split('\n').pop());
  await closeTabs([tabId]);
  return on;
}

test('前台保护关着：页面里不装 window.open 的替换', async () => {
  await setSwitch('patchFrontGuard', false);
  assert.equal(await shimInstalled(), false, '关掉前台保护后不该注入拦截');
});

test('前台保护开着：页面里装上替换', async () => {
  await setSwitch('patchFrontGuard', true);
  assert.equal(await shimInstalled(), true, '开着前台保护时应该注入拦截');
});

test('前台诊断关着：切标签不产生新记录', async () => {
  await setSwitch('patchFrontLog', false);
  const r = await c.call('tabs', { action: 'new', url: `https://example.com/?${TAG}-diag-off=${Date.now()}`, label: `${TAG}-diagoff` });
  const target = r.tabId;
  await sleep(600);
  await c.call('tabs', { action: 'select', tabId: target, focus: true }).catch(() => {});
  await sleep(1200);
  const last = await lastFrontLogTab();
  await closeTabs([target]);
  assert.notEqual(last, target, '诊断关掉后不该记到这次切换');
});

test('前台诊断开着：切标签会记下来', async () => {
  await setSwitch('patchFrontLog', true);
  const r = await c.call('tabs', { action: 'new', url: `https://example.com/?${TAG}-diag-on=${Date.now()}`, label: `${TAG}-diagon` });
  const target = r.tabId;
  await sleep(600);
  await c.call('tabs', { action: 'select', tabId: target, focus: true }).catch(() => {});
  await sleep(1200);
  const last = await lastFrontLogTab();
  await closeTabs([target]);
  assert.equal(last, target, `诊断开着时最后一条应该是 [${target}]，实际是 ${last}`);
});
