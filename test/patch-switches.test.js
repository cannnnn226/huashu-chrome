// 本地补丁开关：静态契约。
//
// 这些开关是把本地改动和官方行为隔开的唯一闸门。任何一处判定漏了开关，
// 用户就再也分不清「这是官方的问题还是我加的东西在捣乱」——而这正是当初
// 加开关的理由。所以每个功能都得有一个可验证的判定点，不能靠人眼看。
//
// 行为验证（真的开页、真的回收）在 test/patch-behavior.test.js，要浏览器。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const background = fs.readFileSync(path.join(ROOT, 'extension/background.js'), 'utf8');
const panelHtml = fs.readFileSync(path.join(ROOT, 'extension/panel.html'), 'utf8');
const panelJs = fs.readFileSync(path.join(ROOT, 'extension/panel.js'), 'utf8');

// 每个功能：开关键、判定点所在的函数、面板上的元素 id
const FEATURES = [
  { key: 'patchFrontGuard', label: '前台保护', marker: "patchOn('frontGuard')", panel: 'patchFrontGuard' },
  { key: 'patchReclaim', label: '标签页回收', marker: "patchOn('reclaim')", panel: 'patchReclaim' },
];

test('每个功能都有开关，且开关键在后台与面板一致', () => {
  for (const f of FEATURES) {
    assert.ok(background.includes(`'${f.key}'`), `后台不认识 ${f.key}`);
    assert.ok(panelJs.includes(`'${f.key}'`), `面板没写 ${f.key}`);
    assert.ok(panelHtml.includes(`id="${f.panel}"`), `面板缺 ${f.panel} 元素`);
  }
});

test('每个功能都有实际判定点，不是摆设开关', () => {
  for (const f of FEATURES) {
    assert.ok(background.includes(f.marker), `${f.label} 没有判定点：${f.marker} 一处都没用上`);
  }
});

test('总开关一关，所有功能都不生效', () => {
  assert.ok(/patchCfg\.master\s*&&\s*patchCfg\[k\]/.test(background),
    'patchOn 没把总开关和各功能开关组合起来');
  // 判定点必须走 patchOn，不能各写各的
  const raw = [...background.matchAll(/if \(!?patchCfg\[/g)];
  assert.equal(raw.length, 0, '有地方绕过 patchOn 直接读 patchCfg');
});

test('未设置算开，只有明确 false 才算关', () => {
  assert.ok(/cfg\[k\]\s*=\s*all\[key\]\s*!==\s*false/.test(background), '后台默认值判断不对');
  assert.ok(/cfg\[key\]\s*!==\s*false/.test(panelJs), '面板默认值判断不对');
});

test('开关改动会刷新内存缓存，不用重启扩展', () => {
  assert.ok(/chrome\.storage\.onChanged\.addListener/.test(background), '没有监听存储变化');
  assert.ok(/PATCH_KEY_SET\.has\(k\)/.test(background), '存储变化没过滤补丁键');
  assert.ok(/patchCfg = readPatchCfg/.test(background), '变化后没重算缓存');
});

test('测试入口能设置每一个开关', () => {
  assert.ok(/p\.action === 'patch'/.test(background), '缺 patch 入口');
  assert.ok(/Object\.entries\(PATCH_KEYS\)\.find/.test(background), '入口没校验 key 合法性');
  assert.ok(/patchCfg = \{ \.\.\.patchCfg/.test(background), '入口没同步更新内存缓存');
});

test('总开关关着时子项置灰，不留「开着却没效果」的假象', () => {
  assert.ok(/function syncPatchDisabled/.test(panelJs), '缺置灰逻辑');
  assert.ok(/\.disabled = !master/.test(panelJs), '子项没有禁用到总开关上');
});
