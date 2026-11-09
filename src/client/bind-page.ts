/**
 * 端内绑定面板 — 扫码 / 手动填写 / 已绑定编辑
 *
 * 宿主插件注册 /qqterm/bind 路由（待绑定与已绑定 fiber 均常驻）：
 * - 未绑定：waiting（二维码）/ starting / saving / failed 相位 + manual 提交
 * - 已绑定：bound 相位（回显脱敏 appId，secret 不回传）+ manual 更换 + 解绑
 * 扫码成功或手动保存均写入 profile patch 并经 HMR 重载生效。
 *
 * 样式为注入式 CSS 类（qqterm-bind-* 命名空间，随面板挂载注入一次）：
 * hover/过渡/focus 样式无法用 inline style 表达，统一走类；
 * 颜色尽量取 DSW 主题变量（--dsw-alias-*），缺省值兜底。
 *
 * 同一组件复用于两种展示位（侧栏绑定页 / 设置页 QQ Bot 栏目）。
 * 运行时仅依赖 react（dsh 客户端平台种子表提供）；宿主通信走同源 fetch，
 * Desktop 下由壳的 IPC 桥自动附加 Host 认证转发。
 */
import { createElement, useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import {
  BIND_MANUAL_PATH,
  BIND_REFRESH_PATH,
  BIND_STATE_PATH,
  BIND_UNBIND_PATH,
  type BindStateWire,
} from '../shared/bind-protocol.ts';

/** 轮询间隔（毫秒）：活跃轮询 / 失败退避 */
const ACTIVE_POLL_MS = 2000;
const RETRY_POLL_MS = 3000;

/** 样式注入标记（幂等） */
const STYLE_ID = 'qqterm-bind-panel-styles';

/**
 * 注入面板样式（全局一次，幂等）。交互态（hover/active/focus）无法用 inline
 * style 表达，统一收敛到类；DSW 主题变量缺失时用中性值兜底。
 * 插件激活时即安装：插件详情按钮渲染在面板之外，需提前可见；
 * 安装后不再随挂载移除，避免多个展示位互相清掉样式。
 */
export function installPanelStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID) !== null) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.qqterm-bind-panel {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 14px; padding: 24px; min-height: 320px; text-align: center; font-size: 14px;
}
.qqterm-bind-title { margin: 0; font-size: 16px; font-weight: 600; }
.qqterm-bind-hint { margin: 0; opacity: 0.75; line-height: 1.6; }
.qqterm-bind-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.qqterm-bind-link { font-size: 13px; opacity: 0.85; color: var(--dsw-alias-brand, #4d6bfe); text-decoration: none; }
.qqterm-bind-link:hover { text-decoration: underline; }
.qqterm-bind-icon { font-size: 32px; line-height: 1; }
.qqterm-bind-qr { border-radius: 10px; background: #fff; padding: 10px; max-width: 100%; }
.qqterm-bind-row { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
.qqterm-bind-btn, .qqterm-bind-pill {
  font: inherit; cursor: pointer; color: inherit;
  transition: background-color .15s ease, border-color .15s ease, color .15s ease, opacity .15s ease;
}
.qqterm-bind-btn:disabled, .qqterm-bind-pill:disabled { opacity: 0.5; cursor: default; }
.qqterm-bind-btn {
  padding: 7px 18px; border-radius: 8px; font-size: 13px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.4));
  background: transparent;
}
.qqterm-bind-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12)); }
.qqterm-bind-btn--primary {
  border-color: transparent;
  background: var(--dsw-alias-brand, #4d6bfe); color: #fff; font-weight: 500;
}
.qqterm-bind-btn--primary:hover:not(:disabled) { background: var(--dsw-alias-brand-strong, #3b5cf0); }
.qqterm-bind-btn--danger { color: var(--dsw-alias-danger, #f26d6d); border-color: var(--dsw-alias-danger, rgba(242, 109, 109, 0.5)); }
.qqterm-bind-btn--danger:hover:not(:disabled) { background: var(--dsw-alias-danger, rgba(242, 109, 109, 0.12)); }
.qqterm-bind-ghost {
  border: none; background: transparent; opacity: 0.65; padding: 4px 8px;
  font: inherit; font-size: 13px; cursor: pointer; color: inherit;
}
.qqterm-bind-ghost:hover { opacity: 1; text-decoration: underline; }
.qqterm-bind-pill {
  padding: 5px 16px; border-radius: 999px; font-size: 13px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.4)); background: transparent;
}
.qqterm-bind-pill:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12)); }
.qqterm-bind-btn:focus-visible, .qqterm-bind-pill:focus-visible, .qqterm-bind-input:focus-visible, .qqterm-bind-ghost:focus-visible {
  outline: 2px solid var(--dsw-alias-brand, #4d6bfe); outline-offset: 1px;
}
.qqterm-bind-form { display: flex; flex-direction: column; gap: 12px; width: min(320px, 100%); box-sizing: border-box; }
.qqterm-bind-field { display: flex; flex-direction: column; gap: 5px; text-align: left; font-size: 13px; }
.qqterm-bind-input {
  padding: 8px 10px; border-radius: 8px; box-sizing: border-box; width: 100%;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.4));
  background: var(--dsw-alias-bg-input, rgba(128, 128, 128, 0.08));
  color: inherit; font: inherit; font-size: 13px; outline: none;
}
.qqterm-bind-input:focus { border-color: var(--dsw-alias-brand, #4d6bfe); }
.qqterm-bind-error { margin: 0; font-size: 12px; color: var(--dsw-alias-danger, #f26d6d); }
/* 紧凑状态视图（已绑定 / 过渡态）：设置行风格，无居中大卡留白 */
.qqterm-bind-status { display: flex; flex-direction: column; text-align: left; font-size: 14px; }
.qqterm-bind-status-row { display: flex; align-items: center; gap: 12px; padding: 12px 0; }
.qqterm-bind-status-icon { font-size: 24px; line-height: 1; flex: none; }
.qqterm-bind-qqicon {
  flex: none; display: block; border-radius: 8px; /* 透明底，QQ 蓝徽标在明暗主题下均清晰 */
}
.qqterm-bind-status-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.qqterm-bind-status-title { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.5; }
.qqterm-bind-status-sub { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, inherit); opacity: .85; }
.qqterm-bind-status-actions { display: flex; align-items: center; gap: 8px; padding: 4px 0 12px; }
/* 扫码成功后的连接过渡：二维码模糊变暗 + 覆盖层 */
.qqterm-bind-scanned { position: relative; display: inline-block; }
.qqterm-bind-scanned-qr {
  display: block; border-radius: 10px; background: #fff; padding: 10px;
  filter: blur(6px) saturate(0.6); opacity: 0.55;
}
.qqterm-bind-scanned-veil {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 6px; text-align: center;
}
.qqterm-bind-scanned-title { margin: 0; font-size: 15px; font-weight: 600; }
.qqterm-bind-scanned-sub { margin: 0; font-size: 12px; opacity: 0.75; line-height: 1.6; }
    `;
  document.head.appendChild(style);
}

function usePanelStyles(): void {
  useEffect(() => { installPanelStyles(); }, []);
}

/**
 * 绑定状态轮询 hook。
 *
 * 404 语义分两种：从未拿到过路由 = 插件未启用（终态）；
 * 曾经拿到过 = HMR 重载窗口期（manual/unbind 保存后路由短暂消失），
 * 低频等待恢复而不是判定终态——否则保存成功提示会被
 * 「插件未启用」覆盖且无法自愈。
 *
 * bound 为稳定态：轮询大幅降频（30s）。因此解绑等本地动作后必须
 * 调用 recheck() 立即重置节拍——否则视图最长停留 30s+ 才收敛到
 * 新相位（如解绑后的 waiting 二维码）。
 *
 * @returns 轮询快照与 recheck：state 为宿主相位（null = 加载中），
 *          gone 表示插件未启用（从未注册过路由），recheck 废弃当前
 *          定时器并立即重新轮询（新轮询链取代旧链，不产生双计时器）。
 */
export function useBindState(enabled = true): { state: BindStateWire | null; gone: boolean; recheck: () => void } {
  const [state, setState] = useState<BindStateWire | null>(null);
  const [gone, setGone] = useState(false);
  const recheckRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let sawRoute = false;
    let generation = 0;
    let running = false;
    let restartAfterFlight = false;
    // recheck 后的快速收敛窗口：解绑等动作改变的是服务端状态（经
    // HMR 异步生效），动作后立即轮询拿到的可能仍是旧 fiber 的相位
    // （如 bound→30s 降频），窗口期内强制快轮询直到相位真正变化
    let urgentUntil = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = (ms: number): void => {
      timer = setTimeout(() => { void tick(); }, ms);
    };

    const intervalFor = (phase: BindStateWire['phase']): number => {
      const base = phase === 'saving' ? 500 : phase === 'bound' ? 30000 : ACTIVE_POLL_MS;
      return Date.now() < urgentUntil ? Math.min(base, ACTIVE_POLL_MS) : base;
    };

    const tick = async (): Promise<void> => {
      if (stopped || running) return;
      running = true;
      const myGeneration = generation;
      const alive = (): boolean => myGeneration === generation && !stopped;
      try {
        const res = await fetch(BIND_STATE_PATH, { cache: 'no-store' });
        if (res.status === 404) {
          if (!stopped && !sawRoute) setGone(true);
          // sawRoute：HMR 窗口期，保留当前视图等待路由恢复
          else if (alive()) schedule(Date.now() < urgentUntil ? 1000 : 3000);
          return;
        }
        if (!res.ok) {
          if (alive()) schedule(RETRY_POLL_MS);
          return;
        }
        sawRoute = true;
        const body = (await res.json()) as BindStateWire;
        if (!alive()) return;
        setState(body);
        schedule(intervalFor(body.phase));
        return;
      } catch {
        // 宿主启动窗口期不可达：退避重试
      } finally {
        running = false;
        // 在飞期间被 recheck 取代：接力启动新轮询链（否则链会断）
        if (restartAfterFlight && !stopped) {
          restartAfterFlight = false;
          void tick();
        }
      }
      if (alive()) schedule(RETRY_POLL_MS);
    };

    // 立即重置节拍：废弃当前计时器，旧轮询链（在飞请求）作废，
    // 新链立即发起，并进入快速收敛窗口
    recheckRef.current = (): void => {
      generation += 1;
      urgentUntil = Date.now() + 15000;
      if (timer !== undefined) clearTimeout(timer);
      if (running) {
        restartAfterFlight = true;
        return;
      }
      void tick();
    };

    void tick();
    return () => { stopped = true; if (timer !== undefined) clearTimeout(timer); };
  }, []);

  const recheck = useCallback((): void => { recheckRef.current(); }, []);

  return { state, gone, recheck };
}

interface ManualResult { ok: boolean; message?: string; error?: string }

/** 手动提交凭据（填写 / 更换共用）；owner 留空表示保留现有绑定用户 */
async function submitManualCredentials(appId: string, appSecret: string, owner: string): Promise<ManualResult> {
  try {
    const res = await fetch(BIND_MANUAL_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId, appSecret, owner }),
    });
    const body = (await res.json().catch(() => ({}))) as ManualResult;
    if (res.ok && body.ok) return { ok: true, message: body.message };
    return { ok: false, error: body.error ?? `保存失败（HTTP ${res.status}）` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 手动凭据表单（填写 / 更换共用）。
 *
 * appSecret 永不回显（占位符提示），提交成功后展示保存结果；
 * 宿主写入 profile patch 并经 HMR 重载，状态轮询随后收敛为 bound。
 */
function ManualForm({ initialAppId }: { initialAppId?: string }): ReactNode {
  const [appId, setAppId] = useState(initialAppId ?? '');
  const [appSecret, setAppSecret] = useState('');
  const [owner, setOwner] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ManualResult | null>(null);

  const submit = useCallback((event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    const trimmedId = appId.trim();
    const trimmedSecret = appSecret.trim();
    if (trimmedId.length === 0 || trimmedSecret.length === 0) {
      setResult({ ok: false, error: 'appId 与 appSecret 均为必填' });
      return;
    }
    setBusy(true);
    void submitManualCredentials(trimmedId, trimmedSecret, owner.trim()).then((outcome) => {
      setResult(outcome);
      setBusy(false);
    });
  }, [appId, appSecret, owner, busy]);

  if (result !== null && result.ok) {
    return createElement('div', { className: 'qqterm-bind-status' },
      createElement('div', { className: 'qqterm-bind-status-row' },
        createElement('div', { className: 'qqterm-bind-status-icon' }, '✅'),
        createElement('div', { className: 'qqterm-bind-status-meta' },
          createElement('p', { className: 'qqterm-bind-status-title' }, result.message ?? '凭据已保存'),
          createElement('p', { className: 'qqterm-bind-status-sub' }, '插件将自动重载；未填允许的用户时需在设置里补填 OpenID'),
        ),
      ),
    );
  }

  return createElement('form', { className: 'qqterm-bind-form', onSubmit: submit },
    createElement('label', { className: 'qqterm-bind-field' },
      'AppID',
      createElement('input', {
        className: 'qqterm-bind-input', value: appId, placeholder: 'QQ 机器人 AppID',
        onChange: (event) => { setAppId(event.currentTarget.value); },
        autoComplete: 'off', spellCheck: false,
      }),
    ),
    createElement('label', { className: 'qqterm-bind-field' },
      'AppSecret',
      createElement('input', {
        className: 'qqterm-bind-input', type: 'password', value: appSecret,
        placeholder: initialAppId === undefined ? 'QQ 机器人 AppSecret' : '输入新的 AppSecret（不回显）',
        onChange: (event) => { setAppSecret(event.currentTarget.value); },
        autoComplete: 'new-password',
      }),
    ),
    createElement('label', { className: 'qqterm-bind-field' },
      '允许的用户',
      createElement('input', {
        className: 'qqterm-bind-input', value: owner,
        placeholder: 'QQ OpenID（可留空，之后在设置里填）',
        onChange: (event) => { setOwner(event.currentTarget.value); },
        autoComplete: 'off', spellCheck: false,
      }),
    ),
    result !== null && !result.ok
      ? createElement('p', { className: 'qqterm-bind-error' }, result.error)
      : null,
    createElement('button', { className: 'qqterm-bind-btn qqterm-bind-btn--primary', type: 'submit', disabled: busy },
      busy ? '正在保存…' : '保存'),
  );
}

/** QQ 机器人 logo 路径（assets/icons/qqbot_logo.svg，内嵌以保持 bundle 自包含） */
export const QQ_BOT_LOGO_PATH =
  'M19.3862 15.5001C19.3861 11.4203 16.0789 8.11296 11.999 8.11292C7.91915 8.11292 4.61203 11.4203 4.61182 15.5001V17.0001C4.61182 18.5949 5.90429 19.8873 7.49902 19.8873H16.499C18.0937 19.8873 19.3862 18.5949 19.3862 17.0001V15.5001ZM10.6118 14.0001C10.6118 14.6145 10.1129 15.1134 9.49853 15.1134C8.8843 15.1132 8.38672 14.6144 8.38672 14.0001V12.0006C8.38672 11.3863 8.8843 10.8875 9.49853 10.8873C10.1129 10.8873 10.6118 11.3862 10.6118 12.0006V14.0001ZM15.6113 14.0001C15.6113 14.6143 15.1136 15.1131 14.4995 15.1134C13.8851 15.1134 13.3862 14.6145 13.3862 14.0001V12.0006C13.3862 11.3862 13.8851 10.8873 14.4995 10.8873C15.1136 10.8876 15.6113 11.3864 15.6113 12.0006V14.0001ZM14.2607 3.04895C14.2607 3.89351 13.7957 4.62474 13.1108 5.0133V5.95374C17.8958 6.50514 21.6112 10.5676 21.6113 15.5001V17.0001C21.6113 19.8237 19.3225 22.1124 16.499 22.1124H7.49902C4.67546 22.1124 2.38672 19.8237 2.38672 17.0001V15.5001C2.38691 10.568 6.10139 6.50571 10.8857 5.95374V5.01185C10.2017 4.62305 9.73583 3.89286 9.73583 3.04895C9.73609 1.79961 10.7496 0.787231 11.999 0.787231C13.2484 0.787297 14.2605 1.79966 14.2607 3.04895Z';

/** QQ 机器人图标（logo 矢量渲染，透明底，随 size 缩放） */
function QqBotIcon({ size = 28 }: { size?: number }): ReactNode {
  return createElement('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    'aria-hidden': true, className: 'qqterm-bind-qqicon',
  },
    createElement('path', { d: QQ_BOT_LOGO_PATH, fill: '#0085FF' }),
  );
}
/** 已绑定视图：回显 appId + 更换凭据 / 解绑入口 */
function BoundView({ appId, recheck }: { appId: string; recheck: () => void }): ReactNode {
  const [editing, setEditing] = useState(false);
  const [unbindResult, setUnbindResult] = useState<{ ok: boolean; message: string } | null>(null);

  const unbind = useCallback((): void => {
    if (!window.confirm('确定解绑吗？\n解绑后机器人立即下线，插件将重新进入扫码绑定流程。')) return;
    void fetch(BIND_UNBIND_PATH, { method: 'POST' })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
        if (res.ok && body.ok === true) {
          setUnbindResult({ ok: true, message: body.message ?? '已解绑，插件将重载并重新进入绑定流程' });
          // bound 态轮询已降频到 30s：立即重置节拍，让 waiting（二维码）
          // 尽快出现而不是等下一个 30s 周期
          recheck();
          return;
        }
        setUnbindResult({ ok: false, message: body.error ?? `解绑失败（HTTP ${res.status}）` });
      })
      .catch((err: unknown) => {
        setUnbindResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
      });
  }, [recheck]);

  if (unbindResult !== null) {
    // 非终态视图：解绑成功后正常由轮询收敛到 waiting；若 HMR 未
    // 触发（状态停留 bound），用户仍有「刷新状态」出口而不是死胡同
    return createElement('div', { className: 'qqterm-bind-status' },
      createElement('div', { className: 'qqterm-bind-status-row' },
        createElement('div', { className: 'qqterm-bind-status-icon' }, unbindResult.ok ? '👋' : '⚠️'),
        createElement('div', { className: 'qqterm-bind-status-meta' },
          createElement('p', { className: 'qqterm-bind-status-title' }, unbindResult.message),
        ),
        unbindResult.ok
          ? createElement('button', { className: 'qqterm-bind-ghost', onClick: recheck }, '刷新状态')
          : createElement('button', { className: 'qqterm-bind-ghost', onClick: () => { setUnbindResult(null); } }, '返回'),
      ),
    );
  }

  if (editing) {
    return createElement('div', { className: 'qqterm-bind-status' },
      createElement('div', { className: 'qqterm-bind-status-row' },
        createElement('div', { className: 'qqterm-bind-status-meta' },
          createElement('p', { className: 'qqterm-bind-status-title' }, '更换凭据'),
        ),
        createElement('button', { className: 'qqterm-bind-ghost', onClick: () => { setEditing(false); } }, '返回'),
      ),
      createElement(ManualForm, { initialAppId: appId }),
    );
  }
  return createElement('div', { className: 'qqterm-bind-status' },
    createElement('div', { className: 'qqterm-bind-status-row' },
      createElement(QqBotIcon, { size: 28 }),
      createElement('div', { className: 'qqterm-bind-status-meta' },
        createElement('p', { className: 'qqterm-bind-status-title' }, '已绑定'),
        createElement('p', { className: 'qqterm-bind-status-sub qqterm-bind-mono' }, `AppID ${appId} · 私聊已接入`),
      ),
    ),
    createElement('div', { className: 'qqterm-bind-status-actions' },
      createElement('button', { className: 'qqterm-bind-btn qqterm-bind-btn--primary', onClick: () => { setEditing(true); } }, '更换凭据'),
      createElement('button', { className: 'qqterm-bind-btn qqterm-bind-btn--danger', onClick: unbind }, '解绑'),
    ),
  );
}

/** 未绑定视图：扫码 / 手动填写切换 */
function UnboundView({ state }: { state: Extract<BindStateWire, { phase: 'waiting' }> }): ReactNode {
  const [mode, setMode] = useState<'qr' | 'manual'>('qr');
  const refresh = useCallback(() => { void fetch(BIND_REFRESH_PATH, { method: 'POST' }).catch(() => {}); }, []);
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => { setImgFailed(false); }, [state.qrSvg]);

  if (mode === 'manual') {
    return createElement('div', { className: 'qqterm-bind-panel' },
      createElement('p', { className: 'qqterm-bind-title' }, '手动填写凭据'),
      createElement(ManualForm, {}),
      createElement('button', { className: 'qqterm-bind-ghost', onClick: () => { setMode('qr'); } }, '改用扫码绑定'),
    );
  }

  if (state.qrSvg === undefined || imgFailed) {
    return createElement('div', { className: 'qqterm-bind-panel' },
      createElement('div', { className: 'qqterm-bind-icon' }, '⚠️'),
      createElement('p', { className: 'qqterm-bind-title' }, '二维码暂时无法显示'),
      createElement('p', { className: 'qqterm-bind-hint' }, '可重启应用后重试，或任选下面一种方式继续'),
      createElement('a', { href: state.url, target: '_blank', rel: 'noreferrer noopener', className: 'qqterm-bind-link' }, '在浏览器中打开链接扫码'),
      createElement('div', { className: 'qqterm-bind-row' },
        createElement('button', { className: 'qqterm-bind-pill', onClick: () => { setMode('manual'); } }, '手动填写凭据'),
      ),
    );
  }

  return createElement('div', { className: 'qqterm-bind-panel' },
    createElement('img', {
      src: state.qrSvg, alt: 'QQ 扫码二维码', width: 220, height: 220, className: 'qqterm-bind-qr',
      onError: () => { setImgFailed(true); },
    }),
    createElement('p', { className: 'qqterm-bind-title' }, '扫码绑定 QQ 机器人'),
    createElement('p', { className: 'qqterm-bind-hint' }, '使用手机 QQ 扫描二维码完成绑定'),
    createElement('a', { href: state.url, target: '_blank', rel: 'noreferrer noopener', className: 'qqterm-bind-link' }, '二维码显示异常？在浏览器中打开'),
    createElement('div', { className: 'qqterm-bind-row' },
      createElement('button', { className: 'qqterm-bind-pill', onClick: refresh }, '刷新二维码'),
      createElement('button', { className: 'qqterm-bind-pill', onClick: () => { setMode('manual'); } }, '手动填写'),
    ),
  );
}

/** 依据宿主相位渲染面板主体（可注入共享轮询结果避免双计时器） */
export function BindPanelBody(props: {
  state?: BindStateWire | null;
  gone?: boolean;
  recheck?: () => void;
} = {}): ReactElement {
  usePanelStyles();
  const injected = props?.state !== undefined;
  const internal = useBindState(!injected);
  const state = injected ? (props.state ?? null) : internal.state;
  const gone = injected ? (props.gone ?? false) : internal.gone;
  const recheck = injected ? (props.recheck ?? (() => {})) : internal.recheck;
  // 扫码成功的连接过渡场景需要保留最后一帧二维码：waiting 相位持续记录，
  // bound 后清空（避免下次解绑重绑时旧码闪现）
  const [lastQr, setLastQr] = useState<string | null>(null);
  useEffect(() => {
    if (state === null) return;
    if (state.phase === 'waiting') {
      if (state.qrSvg !== undefined) setLastQr(state.qrSvg);
    } else if (state.phase === 'bound') {
      setLastQr(null);
    }
  }, [state]);

  if (gone) {
    return createElement('div', { className: 'qqterm-bind-panel' },
      createElement('div', { className: 'qqterm-bind-icon' }, '❔'),
      createElement('p', { className: 'qqterm-bind-hint' }, '插件未启用，或当前版本不支持端内配置'),
    );
  }

  if (state === null || state.phase === 'starting') {
    return createElement('div', { className: 'qqterm-bind-panel' },
      createElement('p', { className: 'qqterm-bind-hint' }, '正在获取绑定状态…'),
    );
  }

  if (state.phase === 'saving') {
    // 扫码路径：保留二维码做模糊过渡（手动填写路径无二维码，用紧凑态）
    if (lastQr !== null) {
      return createElement('div', { className: 'qqterm-bind-panel' },
        createElement('div', { className: 'qqterm-bind-scanned' },
          createElement('img', { src: lastQr, alt: 'QQ 扫码二维码', width: 220, height: 220, className: 'qqterm-bind-scanned-qr' }),
          createElement('div', { className: 'qqterm-bind-scanned-veil' },
            createElement('p', { className: 'qqterm-bind-scanned-title' }, '✅ 扫码成功'),
            createElement('p', { className: 'qqterm-bind-scanned-sub' }, '正在连接机器人，稍候…'),
          ),
        ),
      );
    }
    return createElement('div', { className: 'qqterm-bind-status' },
      createElement('div', { className: 'qqterm-bind-status-row' },
        createElement('div', { className: 'qqterm-bind-status-icon' }, '🎉'),
        createElement('div', { className: 'qqterm-bind-status-meta' },
          createElement('p', { className: 'qqterm-bind-status-title' }, '扫码成功'),
          createElement('p', { className: 'qqterm-bind-status-sub' }, '凭据已保存，插件正在重载，稍后即可开始对话'),
        ),
      ),
    );
  }

  if (state.phase === 'failed') {
    return createElement('div', { className: 'qqterm-bind-panel' },
      createElement('div', { className: 'qqterm-bind-icon' }, '⚠️'),
      createElement('p', { className: 'qqterm-bind-title' }, '绑定失败'),
      createElement('p', { className: 'qqterm-bind-hint' }, state.reason),
      createElement('div', { className: 'qqterm-bind-row' },
        createElement('button', { className: 'qqterm-bind-btn qqterm-bind-btn--primary', onClick: () => { window.location.reload(); } }, '重试'),
      ),
    );
  }

  if (state.phase === 'bound') {
    return createElement(BoundView, { appId: state.appId, recheck });
  }

  return createElement(UnboundView, { state });
}
