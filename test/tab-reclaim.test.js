// 标签页回收的跨文件契约。
//
// 这套逻辑散在 background（记号、上限、回收）、panel（开关、遗留页入口）和
// 两条命令入口（tabs new / 点击跟过去的子页）之间。任何一侧单独改名都不会
// 报错——页只是继续堆着，或者更糟：把用户自己的页也关掉。在这里守住边界。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const background = read('extension/background.js');
const panelJs = read('extension/panel.js');
const panelHtml = read('extension/panel.html');

const fnBody = (name, src = background) => {
  const i = src.indexOf(`async function ${name}(`);
  assert.ok(i > 0, `background.js 里找不到 ${name}`);
  // 到下一个顶层函数/常量声明为止，够覆盖函数体
  const rest = src.slice(i + 10);
  const j = rest.search(/\n(async function |function |const |chrome\.|let |\/\/ ----------)/);
  return rest.slice(0, j > 0 ? j : rest.length);
};

test('tabs new 开出来的页要盖章', () => {
  const i = background.indexOf("if (p.action === 'new')");
  assert.ok(i > 0, 'tabs new 分支不见了');
  const branch = background.slice(i, i + 900);
  assert.ok(/markMade\(sid,\s*tab,/.test(branch), 'tabs new 没有 markMade：会话结束后这些页永远收不掉');
  assert.ok(/capSessionTabs\(sid,\s*tab\.id/.test(branch), 'tabs new 没有执行单会话上限');
});

test('点击跟过去的子页也要盖章', () => {
  assert.ok(/markMade\(ctx\?\.sid,\s*child,/.test(background),
    'childOpenedSince 跟过去的新页没盖章：搜索结果页会绕开回收');
});

test('关页顺手摘掉记号', () => {
  assert.ok(/all\[madeKey\(tabId\)\]/.test(background),
    'onRemoved 没清 madeBy 记号：关掉的 tabId 会被回收逻辑反复点名，而 chrome.tabs.remove 每次都要失败一次');
});

test('alarm 每轮都扫一遍回收', () => {
  assert.ok(/chrome\.alarms\?\.onAlarm\.addListener\(async \(\) => \{\s*void reclaimIdleTabs\(\)/.test(background),
    'onAlarm 没调 reclaimIdleTabs：会话下线后只能等下一个事件，可能永远不来');
});

test('回收只认自己盖过章的页', () => {
  const body = fnBody('reclaimIdleTabs');
  assert.ok(body.includes('MADE_PREFIX'), '回收没有按 madeBy 记号筛页');
  assert.ok(!body.includes('REG_PREFIX') && !body.includes('regKey'),
    '回收逻辑碰了户口簿：户口簿里混着用户自己的页，会误关');
  assert.ok(body.includes('live.has'), '回收没有判在线名单：会把还在跑的会话的页关掉');
  assert.ok(body.includes('RECLAIM_GRACE_MS'), '回收没有宽限期');
});

test('单会话上限永远留下刚开的那一页', () => {
  const body = fnBody('capSessionTabs');
  assert.ok(body.includes('keepTabId'), 'capSessionTabs 没有豁免 keepTabId：可能刚开完就被自己关掉');
  assert.ok(body.includes('TAB_CAP'), '没有上限常量');
});

test('遗留页清理只给显式入口，且不碰在线会话的页', () => {
  const body = fnBody('orphanAgentTabs');
  assert.ok(body.includes('sidsOnTab') && body.includes('live.has'),
    '遗留页判定没有排除在线会话占着的页');
  // 自动路径（alarm / sessions 事件）不得调用它——它可能关掉用户交给 agent 的页
  const auto = background.slice(background.indexOf('onBridgeEvent'), background.indexOf('const err ='));
  assert.ok(!auto.includes('orphanAgentTabs'), '遗留页清理不能挂在自动路径上');
  assert.ok(!/chrome\.alarms[\s\S]{0,400}orphanAgentTabs/.test(background), '定时任务里不能清遗留页');
});

test('侧栏开关与后台读的是同一个键', () => {
  const key = 'localPatchEnabled';
  assert.ok(background.includes(key), '后台没有读回收开关');
  assert.ok(panelJs.includes(key), '侧栏没有写回收开关');
  assert.ok(panelHtml.includes('id="patch"') && panelJs.includes("$('patch')"),
    '侧栏开关的 id 对不上');
});

test('本地补丁每项一个开关，总开关一关全回官方行为', () => {
  assert.ok(/PATCH_KEYS\s*=\s*\{/.test(background), '找不到 PATCH_KEYS');
  for (const key of ['localPatchEnabled', 'patchFrontGuard', 'patchReclaim']) {
    assert.ok(background.includes(`'${key}'`), `开关 ${key} 不见了`);
  }
  // 未设置算开：装上就生效，只有明确存 false 才算关
  assert.ok(/!==\s*false/.test(background), '默认值判断不是「只有明确 false 才算关」');
  assert.ok(/patchCfg\.master\s*&&\s*patchCfg\[k\]/.test(background), 'patchOn 没有同时看总开关和分开关');

  // 回收只管盖章、上限、回收、遗留页
  for (const fn of ['markMade', 'capSessionTabs', 'reclaimIdleTabs', 'orphanAgentTabs']) {
    const body = fnBody(fn);
    assert.ok(body.includes("patchOn('reclaim')") || body.includes('localPatchOn'),
      `${fn} 没有受开关管辖`);
  }
  // 前台保护各入口都看自己的开关
  assert.ok(fnBody('armFrontGuard').includes("patchOn('frontGuard')"), '布防没看前台保护开关');
  assert.ok(fnBody('settleFront').includes("patchOn('frontGuard')"), '归还没看前台保护开关');
  const core = background.slice(background.indexOf('async function performCore'), background.indexOf('async function performCore') + 1200);
  assert.ok(core.includes("patchOn('frontGuard')"), '前台保护没有受开关管辖');
});

test('侧栏默认全开，总开关关掉时子项禁用', () => {
  assert.ok(/checked\s*=\s*[^;]*!==\s*false/.test(panelJs), '侧栏开关默认应为开');
  assert.ok(panelHtml.includes('id="patchFrontGuard"'), '缺前台保护开关');
  assert.ok(panelHtml.includes('id="patchReclaim"'), '缺标签页回收开关');
});

test('无痕窗口不参与盖章与清理', () => {
  assert.ok(fnBody('markMade').includes('tab.incognito'), 'markMade 没排除无痕页');
  assert.ok(/incognito/.test(fnBody('orphanAgentTabs')), '遗留页盘点没排除无痕页');
});

test('遗留页的计数与按钮两侧一致', () => {
  assert.ok(panelHtml.includes('id="orphanCount"') && panelJs.includes("$('orphanCount')"),
    '遗留页计数的 id 对不上');
  assert.ok(panelHtml.includes('id="orphanBtn"') && panelJs.includes("$('orphanBtn')"),
    '清理按钮的 id 对不上');
  for (const verb of ['orphans', 'reclaimOrphans']) {
    assert.ok(background.includes(`'${verb}'`), `background 没接 ${verb}`);
    assert.ok(panelJs.includes(`'${verb}'`), `侧栏没发 ${verb}`);
  }
});
