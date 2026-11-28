/**
 * QQ 机器人配置面板 — 必要配置的 UI 编辑
 *
 * UI 复刻 DSW 通用设置（settings-form 原语）的视觉风格：
 * 左对齐设置列、0.5px 行分隔、label 13px/500、控件右置；
 * Switch 为 36×20 aria-checked 结构（thumb translateX 动画）；
 * 文字类配置用单行输入；
 * 保存按钮为 DSW 反色主按钮（label-primary 底 + bg-layer-3 字）。
 *
 * 数据流：GET /qqterm/config 回显当前生效配置（appSecret
 * 已由宿主剔除）→ 表单编辑 → dirty diff → POST 仅提交变更键 →
 * 宿主白名单 + Schema 校验 → 最小写入 profile patch → HMR 重载生效。
 *
 * 字段策略：只开放用户必要的配置；工作目录跟随会话（不再是一项配置）；
 * 超时与性能调优类字段走 profile patch / 环境变量。
 */
import { createElement, useCallback, useEffect, useState, type ChangeEvent, type FormEvent, type ReactElement, type ReactNode } from 'react';
import { BIND_CONFIG_PATH, PANEL_MAX_ITEMS, type PanelCommandWire } from '../shared/bind-protocol.ts';

/** 访问控制配置（与 src/config.ts 的 AccessControlConfig 对应的局部投影） */
interface AccessControlWire {
  owner: string;
}

/** 指令面板配置（与 src/config.ts 的 PanelConfig 对应的局部投影） */
interface PanelConfigWire {
  enabled?: boolean;
  /** [] = 不展示任何命令 */
  commands?: string[];
}

/** GET 回显的生效配置（appSecret 已剔除） */
type ConfigWire = {
  showToolResults?: boolean;
  access?: AccessControlWire;
  panel?: PanelConfigWire;
};

/** 样式注入标记（幂等） */
const STYLE_ID = 'qqterm-config-panel-styles';

/** DSW 通用设置风格（settings-form / Switch / SegmentedControl 原语复刻） */
function useConfigPanelStyles(): void {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (document.getElementById(STYLE_ID) !== null) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
.qqterm-config-form { display: flex; flex-direction: column; width: 100%; }
.qqterm-config-group-title {
  padding: 14px 0 2px; font-size: 12px; font-weight: 600; line-height: 18px;
  color: var(--dsw-alias-label-tertiary); text-transform: uppercase; letter-spacing: .04em;
}
.qqterm-config-group-title--split { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.qqterm-panel-total {
  font-size: 11px; font-weight: 400; letter-spacing: normal; text-transform: none;
  color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums;
}
.qqterm-config-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.qqterm-config-field + .qqterm-config-field { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.qqterm-config-head { display: flex; align-items: center; gap: 8px; min-height: 28px; }
.qqterm-config-label {
  flex: 1; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.qqterm-config-help { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.qqterm-config-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
/* Switch（aria-checked 驱动，视觉态与无障碍态同源） */
.qqterm-config-switch {
  box-sizing: border-box; position: relative; flex: 0 0 auto;
  width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px;
  background: var(--dsw-alias-border-l3); cursor: pointer; font: inherit;
}
.qqterm-config-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.qqterm-config-switch:disabled { cursor: default; opacity: 0.5; }
.qqterm-config-switch:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.qqterm-config-switch-thumb {
  display: block; width: 16px; height: 16px; border-radius: 50%;
  background: var(--dsw-alias-switch-thumb, #ffffff);
  transition: transform 120ms ease;
}
.qqterm-config-switch[aria-checked='true'] .qqterm-config-switch-thumb {
  background: var(--dsw-alias-label-primary-foreground, #ffffff);
  transform: translateX(16px);
}
/* 输入（官方 fields.input 复刻） */
.qqterm-config-input {
  box-sizing: border-box; width: 100%; height: 34px; padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; line-height: 1.5;
  color: var(--dsw-alias-label-primary); outline: none;
}
.qqterm-config-input:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.qqterm-config-input:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
/* 指令面板选择器：命令多，按组收进卡片，每行一条紧凑展示 */
.qqterm-panel-picker { display: flex; flex-direction: column; padding: 0 0 4px; }
.qqterm-panel-groups { display: flex; flex-direction: column; gap: 14px; }
.qqterm-panel-group-head { padding: 0 12px 6px; }
.qqterm-panel-group-name {
  font-size: 12px; font-weight: 600; line-height: 18px;
  color: var(--dsw-alias-label-secondary); letter-spacing: .02em;
}
.qqterm-panel-group-body {
  overflow: hidden; border: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2));
  border-radius: var(--dsw-radius-xl, 12px);
  background: var(--dsw-alias-settings-card-fill, transparent);
}
.qqterm-panel-row {
  box-sizing: border-box; display: flex; align-items: center; gap: 12px;
  width: 100%; min-height: 36px; margin: 0; padding: 6px 12px;
  border: 0; background: transparent; color: inherit; font: inherit;
  text-align: left; cursor: pointer;
}
.qqterm-panel-row + .qqterm-panel-row { border-top: 0.5px solid var(--dsw-alias-border-l2); }
@media (hover: hover) {
  .qqterm-panel-row:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
}
.qqterm-panel-row:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
.qqterm-panel-row:disabled { cursor: default; }
.qqterm-panel-row:disabled .qqterm-panel-switch { opacity: .45; }
.qqterm-panel-cmd {
  flex: 0 0 auto; width: 88px;
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px; font-weight: 500; line-height: 18px; color: var(--dsw-alias-label-primary);
}
.qqterm-panel-desc {
  flex: 1; min-width: 0; overflow: hidden; font-size: 12px; line-height: 18px;
  color: var(--dsw-alias-label-secondary); text-overflow: ellipsis; white-space: nowrap;
}
.qqterm-panel-switch { flex: none; pointer-events: none; }
.qqterm-panel-switch[data-checked='true'] { background: var(--dsw-alias-brand-primary); }
.qqterm-panel-switch[data-checked='true'] .qqterm-config-switch-thumb {
  background: var(--dsw-alias-label-primary-foreground, #ffffff); transform: translateX(16px);
}
/* 分段控件样式已移除：访问控制只保留唯一用户输入 */
/* 底栏（官方 SettingsForm.footer 复刻） */
.qqterm-config-footer { display: flex; align-items: center; gap: 8px; padding-top: 16px; }
.qqterm-config-note { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.qqterm-config-note--error { color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-error)); }
.qqterm-config-note--ok { color: var(--dsw-alias-label-secondary); }
.qqterm-config-save {
  appearance: none; flex: none; border: 1px solid transparent;
  border-radius: var(--dsw-radius-md, 8px); padding: 5px 14px;
  font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer;
  background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3);
}
.qqterm-config-save:disabled { opacity: 0.4; cursor: default; }
.qqterm-config-save:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
    `;
    document.head.appendChild(style);
    return () => { style.remove(); };
  }, []);
}

/** 开关（官方 Switch 原语结构：aria-checked 驱动视觉态） */
function Switch({ checked, label, onChange, disabled = false }: {
  checked: boolean; label: string; onChange: (next: boolean) => void; disabled?: boolean;
}): ReactNode {
  return createElement('button', {
    type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': label,
    className: 'qqterm-config-switch', disabled,
    onClick: () => { if (!disabled) onChange(!checked); },
  }, createElement('span', { className: 'qqterm-config-switch-thumb' }));
}

/** 开关行（label 左 + Switch 右 + 可选 help） */
function SwitchRow({ label, help, checked, onChange, disabled = false }: {
  label: string; help?: string; checked: boolean; onChange: (next: boolean) => void; disabled?: boolean;
}): ReactNode {
  return createElement('div', { className: 'qqterm-config-field' },
    createElement('div', { className: 'qqterm-config-head' },
      createElement('span', { className: 'qqterm-config-label' }, label),
      createElement(Switch, { checked, label, onChange, disabled }),
    ),
    help === undefined ? null : createElement('p', { className: 'qqterm-config-help' }, help),
  );
}

/** 文本行（label 上 + 输入下，与官方 fields 布局一致） */
function FieldRow({ label, help, value, placeholder, onChange }: {
  label: string; help?: string; value: string; placeholder?: string; onChange: (next: string) => void;
}): ReactNode {
  return createElement('div', { className: 'qqterm-config-field' },
    createElement('span', { className: 'qqterm-config-label' }, label),
    createElement('input', {
      className: 'qqterm-config-input', value, placeholder, spellCheck: false,
      onChange: (event: ChangeEvent<HTMLInputElement>) => { onChange(event.currentTarget.value); },
    }),
    help === undefined ? null : createElement('p', { className: 'qqterm-config-hint' }, help),
  );
}

/** 设置页的命令分组（服务端已按分组顺序下发，这里只做聚合） */
interface CommandGroup {
  /** 未归类的命令没有组名，直接排在最后 */
  label?: string;
  items: PanelCommandWire[];
}

/** 把扁平目录聚合成分组卡片；未归类的合成一组且不显示组名，保持首次出现的先后 */
function groupPanelCommands(commands: readonly PanelCommandWire[]): CommandGroup[] {
  const groups: CommandGroup[] = [];
  const index = new Map<string, CommandGroup>();
  for (const cmd of commands) {
    const key = cmd.group ?? '';
    let group = index.get(key);
    if (group === undefined) {
      group = { label: cmd.group, items: [] };
      index.set(key, group);
      groups.push(group);
    }
    group.items.push(cmd);
  }
  return groups;
}

/** 分组内的一行：整行就是开关（命令名 + 单行说明 + 右侧开关） */
function CommandRow({ command, checked, disabled, onToggle }: {
  command: PanelCommandWire; checked: boolean; disabled: boolean; onToggle: (next: boolean) => void;
}): ReactNode {
  const name = `/${command.name}`;
  return createElement('button', {
    type: 'button', role: 'switch', 'aria-checked': checked,
    'aria-label': command.description === undefined ? name : `${name} ${command.description}`,
    className: 'qqterm-panel-row', disabled,
    onClick: () => { if (!disabled) onToggle(!checked); },
  },
    createElement('span', { className: 'qqterm-panel-cmd' }, name),
    command.description === undefined
      ? null
      : createElement('span', { className: 'qqterm-panel-desc', title: command.description }, command.description),
    createElement('span', { className: 'qqterm-config-switch qqterm-panel-switch', 'data-checked': checked, 'aria-hidden': 'true' },
      createElement('span', { className: 'qqterm-config-switch-thumb' })),
  );
}

/** 一组命令：组名 + 卡片内的紧凑行 */
function CommandGroupCard({ group, isShown, atLimit, onToggle }: {
  group: CommandGroup;
  isShown: (name: string) => boolean;
  atLimit: boolean;
  onToggle: (name: string, next: boolean) => void;
}): ReactNode {
  return createElement('section', { className: 'qqterm-panel-group' },
    group.label === undefined
      ? null
      : createElement('div', { className: 'qqterm-panel-group-head' },
          createElement('span', { className: 'qqterm-panel-group-name' }, group.label),
        ),
    createElement('div', { className: 'qqterm-panel-group-body' },
      group.items.map((cmd) => createElement(CommandRow, {
        key: cmd.name,
        command: cmd,
        checked: isShown(cmd.name),
        // 选满后只锁住未选中的行，已选中的仍可取消
        disabled: !isShown(cmd.name) && atLimit,
        onToggle: (next) => { onToggle(cmd.name, next); },
      })),
    ),
  );
}

/** 深比较（表单值与初始回显值的 dirty 判断） */
function shallowEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 配置面板主体。
 *
 * 保存仅提交变更键（服务端按白名单合并），保存成功后只提示已保存。
 */
export function ConfigPanel(props: { bindPhase?: string } = {}): ReactElement {
  useConfigPanelStyles();
  const [initial, setInitial] = useState<ConfigWire | null>(null);
  const [form, setForm] = useState<ConfigWire | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 命令目录由服务端按当前可见命令现取；网关未就绪时为空
  const [commands, setCommands] = useState<PanelCommandWire[]>([]);
  // 绑定相位变化时重拉配置（扫码落库的白名单等新值）
  const bindPhase = props?.bindPhase;

  useEffect(() => {
    let stopped = false;
    void fetch(BIND_CONFIG_PATH, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { config: ConfigWire; panelCommands?: PanelCommandWire[] };
        if (stopped) return;
        setInitial(body.config);
        setForm(body.config);
        setCommands(body.panelCommands ?? []);
      })
      .catch((err: unknown) => {
        if (!stopped) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => { stopped = true; };
  }, [bindPhase]);

  const patch = useCallback(<K extends keyof ConfigWire>(key: K, value: ConfigWire[K]): void => {
    setForm((current) => current === null ? current : { ...current, [key]: value });
    setResult(null);
  }, []);

  const submit = useCallback((event: FormEvent): void => {
    event.preventDefault();
    if (busy || initial === null || form === null) return;
    const changed: Record<string, unknown> = {};
    for (const key of Object.keys(form) as Array<keyof ConfigWire>) {
      if (!shallowEqual(form[key], initial[key])) {
        changed[key] = form[key];
      }
    }
    if (Object.keys(changed).length === 0) return;

    setBusy(true);
    void fetch(BIND_CONFIG_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(changed),
    })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
        if (res.ok && body.ok === true) {
          setResult({ ok: true, message: body.message ?? '配置已保存' });
          setInitial(form);
          return;
        }
        setResult({ ok: false, message: body.error ?? `保存失败（HTTP ${res.status}）` });
      })
      .catch((err: unknown) => {
        setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => { setBusy(false); });
  }, [busy, form, initial]);

  if (loadError !== null) {
    return createElement('p', { className: 'qqterm-config-hint', style: { padding: '12px 0' } },
      `配置加载失败: ${loadError}`);
  }
  if (initial === null || form === null) {
    return createElement('p', { className: 'qqterm-config-hint', style: { padding: '12px 0' } }, '正在加载配置…');
  }

  const dirty = (Object.keys(form) as Array<keyof ConfigWire>).some((key) => !shallowEqual(form[key], initial[key]));
  const access: AccessControlWire = form.access ?? { owner: '' };
  const panel: PanelConfigWire = form.panel ?? {};
  const panelEnabled = panel.enabled ?? true;
  // 没配置就是一条都不展示；空数组与缺省同义
  const chosenNames = new Set(panel.commands ?? []);
  const isShown = (name: string): boolean => chosenNames.has(name);
  const visibleCount = commands.filter((cmd) => isShown(cmd.name)).length;
  // 上限按当前可见命令算：暂时不可用的历史选择不占面板位置，也不该挡住用户改可见项
  const atLimit = visibleCount >= PANEL_MAX_ITEMS;
  const groups = groupPanelCommands(commands);
  const toggleCommand = (name: string, show: boolean): void => {
    if (show && atLimit) return;
    const next = new Set(chosenNames);
    if (show) next.add(name);
    else next.delete(name);
    // 按面板目录顺序写，并保留暂时不可用命令此前的选择
    const known = commands.map((cmd) => cmd.name).filter((n) => next.has(n));
    const unknown = [...next].filter((n) => !commands.some((cmd) => cmd.name === n));
    patch('panel', { ...panel, commands: [...known, ...unknown] });
  };

  return createElement('form', { className: 'qqterm-config-form', onSubmit: submit },
    createElement('div', { className: 'qqterm-config-group-title' }, '服务范围'),
    createElement(FieldRow, {
      label: '允许的用户',
      help: '只允许这一个 QQ 用户；留空则拒绝所有人',
      placeholder: 'QQ OpenID',
      value: access.owner,
      onChange: (v) => { patch('access', { owner: v }); },
    }),

    createElement('div', { className: 'qqterm-config-group-title' }, '基础设置'),
    createElement(SwitchRow, {
      label: '显示工具调用结果', checked: form.showToolResults ?? false,
      help: '在聊天中展示工具调用结果，含失败',
      onChange: (v) => { patch('showToolResults', v); },
    }),

    createElement('div', { className: 'qqterm-config-group-title qqterm-config-group-title--split' },
      '指令面板',
      commands.length === 0
        ? null
        : createElement('span', { className: 'qqterm-panel-total' }, `已选 ${visibleCount}/${PANEL_MAX_ITEMS}`),
    ),
    createElement(SwitchRow, {
      label: '展示指令面板', checked: panelEnabled,
      onChange: (v) => { patch('panel', { ...panel, enabled: v }); },
    }),
    panelEnabled
      ? commands.length === 0
        ? createElement('p', { className: 'qqterm-config-hint' }, '连接机器人后可选择命令')
        : createElement('div', { className: 'qqterm-panel-picker' },
            createElement('div', { className: 'qqterm-panel-groups' },
              groups.map((group) => createElement(CommandGroupCard, {
                key: group.label ?? '',
                group,
                isShown,
                atLimit,
                onToggle: toggleCommand,
              })),
            ),
          )
      : null,

    createElement('div', { className: 'qqterm-config-footer' },
      result !== null
        ? createElement('p', { className: `qqterm-config-note${result.ok ? ' qqterm-config-note--ok' : ' qqterm-config-note--error'}` },
            (result.ok ? '' : '⚠️ ') + result.message)
        : createElement('p', { className: 'qqterm-config-note' }),
      createElement('button', { className: 'qqterm-config-save', type: 'submit', disabled: busy || !dirty },
        busy ? '正在保存…' : '保存'),
    ),
  );
}
