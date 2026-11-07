#!/usr/bin/env node
/**
 * 开发 profile 一键换包：build → pack（带时间戳）→ dsh plugin add
 *
 * 开发 profile（默认 qqdev）用 tgz 实体副本安装、HMR 常开，改完代码不重启：
 *   1. 打包并装进 profile（本脚本）
 *   2. 在 QQ 里发 /bot-reload，让宿主 reconcileProfile 换掉已加载的模块
 *
 * 用法：node scripts/dev-reload.mjs [profile]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = process.argv[2] ?? 'qqdev';

function run(command, args) {
  const quote = (value) => (/^[\w@%+=:,./\\-]+$/.test(value) ? value : `"${value}"`);
  const line = [command, ...args].map(quote).join(' ');
  const result = spawnSync(line, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    console.error(`\n[dev-reload] 失败：${line}`);
    process.exit(result.status ?? 1);
  }
}

function stamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
// pnpm pack 的文件名规则：去掉 @，scope 分隔符换成 -
const base = `${pkg.name.replace(/^@/, '').replace(/\//g, '-')}-${pkg.version}`;

console.log(`[dev-reload] build ${pkg.name}@${pkg.version}`);
run('pnpm', ['build']);

console.log('[dev-reload] pack');
run('pnpm', ['pack', '--pack-destination', '.pack']);

const packDir = join(root, '.pack');
const packed = join(packDir, `${base}.tgz`);
if (!existsSync(packed)) {
  console.error(`[dev-reload] 没找到打包产物: ${packed}`);
  process.exit(1);
}

// 同一版本重打保留旧包：文件名带时间戳，重名再加序号
let target = join(packDir, `${base}-${stamp(new Date())}.tgz`);
for (let index = 2; existsSync(target); index += 1) {
  target = join(packDir, `${base}-${stamp(new Date())}-${index}.tgz`);
}
renameSync(packed, target);
console.log(`[dev-reload] 产物 ${target}`);

console.log(`[dev-reload] dsh plugin --profile ${profile} add`);
run('dsh', ['plugin', '--profile', profile, 'add', `file:${target.split('\\').join('/')}`]);

console.log(`\n[dev-reload] 已装进 ${profile}，接下来在 QQ 里发 /bot-reload 应用变更。`);
if (!profile.startsWith('qqdev')) {
  console.log(`[dev-reload] 注意：${profile} 需要开启 HMR（cordis.patch.yml 里不能有 - id: hmr / disabled: true）。`);
}
