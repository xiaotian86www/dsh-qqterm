#!/usr/bin/env node
/**
 * 本地发布：拉取 → 构建 → 测试 → 打包 → 装进指定 profile。
 *
 *   node scripts/deploy.mjs [profile] [--pull] [--test]
 *
 *   profile   目标 profile，默认 dev
 *   --pull    先快进到 origin/main（要求当前在 main、工作树干净）
 *   --test    打包前跑 pnpm test
 *
 * 应用变更：QQ 里发 /plugins reload 按磁盘身份换模块；没有 HMR 时重启宿主，
 * 客户端改动另需刷新页面。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.log('用法：node scripts/deploy.mjs [profile] [--pull] [--test]');
  console.log('  profile   目标 profile，默认 dev');
  console.log('  --pull    先快进到 origin/main（要求当前在 main、工作树干净）');
  console.log('  --test    打包前跑 pnpm test');
}

function fail(message) {
  console.error(`[deploy] ${message}`);
  process.exit(1);
}

function log(message) {
  console.log(`[deploy] ${message}`);
}

const options = { profile: null, pull: false, test: false };
for (const arg of process.argv.slice(2)) {
  if (arg === '--pull') {
    options.pull = true;
  } else if (arg === '--test') {
    options.test = true;
  } else if (arg === '-h' || arg === '--help') {
    usage();
    process.exit(0);
  } else if (arg.startsWith('-')) {
    fail(`未知参数 ${arg}（--help 查看用法）`);
  } else if (!options.profile) {
    options.profile = arg;
  } else {
    fail(`多余参数 ${arg}（--help 查看用法）`);
  }
}
options.profile ??= 'dev';

function quote(value) {
  return /^[\w@%+=:,./\\-]+$/.test(value) ? value : `"${value}"`;
}

function run(command, args) {
  const line = [command, ...args].map(quote).join(' ');
  log(line);
  const result = spawnSync(line, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) fail(`失败：${line}`);
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.error) fail(`${command} 无法执行：${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    fail(`${command} ${args.join(' ')} 失败${detail ? `：\n${detail}` : ''}`);
  }
  return (result.stdout ?? '').trim();
}

if (options.pull) {
  const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') fail(`--pull 要求当前在 main（现在是 ${branch}）`);
  const dirty = capture('git', ['status', '--porcelain']);
  if (dirty) fail(`工作树不干净，先提交或清理：\n${dirty.split('\n').slice(0, 5).join('\n')}`);
  const before = capture('git', ['rev-parse', 'HEAD']);
  run('git', ['pull', '--ff-only']);
  const after = capture('git', ['rev-parse', 'HEAD']);
  if (before === after) {
    log('已是最新');
  } else {
    log(`HEAD ${before.slice(0, 7)} → ${after.slice(0, 7)}`);
    const lockfileChanged =
      spawnSync('git', ['diff', '--quiet', before, after, '--', 'pnpm-lock.yaml'], { cwd: root }).status === 1;
    if (lockfileChanged) run('pnpm', ['install', '--frozen-lockfile']);
  }
} else if (!existsSync(join(root, 'node_modules'))) {
  run('pnpm', ['install', '--frozen-lockfile']);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
log(`发布 ${pkg.name}@${pkg.version} → ${options.profile}`);

run('pnpm', ['build']);
if (options.test) run('pnpm', ['test']);

const packDir = join(root, '.pack');
mkdirSync(packDir, { recursive: true });
run('pnpm', ['pack', '--pack-destination', '.pack']);

const base = `${pkg.name.replace(/^@/, '').replace(/\//g, '-')}-${pkg.version}`;
const packed = join(packDir, `${base}.tgz`);
if (!existsSync(packed)) fail(`没找到打包产物: ${packed}`);

function stamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

let target = join(packDir, `${base}-${stamp(new Date())}.tgz`);
for (let index = 2; existsSync(target); index += 1) {
  target = join(packDir, `${base}-${stamp(new Date())}-${index}.tgz`);
}
renameSync(packed, target);
log(`产物 ${target}`);

run('dsh', ['plugin', '--profile', options.profile, 'add', `file:${target.split('\\').join('/')}`]);

console.log(`\n[deploy] 已装进 ${options.profile}。`);
console.log('[deploy] 应用变更：QQ 里发 /plugins reload 按磁盘身份换模块；没有 HMR 时重启宿主，客户端改动另需刷新页面。');
