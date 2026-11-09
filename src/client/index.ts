/**
 * qqterm 浏览器半边 —— QQ Bot 端内扫码绑定入口
 *
 * 宿主插件在凭据缺失时注册 /qqterm/bind 状态路由；本插件在
 * Web / Desktop 只提供一个展示位：
 *
 * 设置页「QQ 超级终端」栏目（settings.section 席位）——注册即展示，
 * 无 Session surface 时序依赖，绑定 / 换凭据 / 解绑与访问控制配置都在这里。
 *
 * 运行时依赖仅 react（客户端平台种子表提供）；宿主服务经 cordis inject
 * 声明访问（声明缺失时插件保持 inactive，不阻塞浏览器启动）。
 */
import type { Context } from '@deepseek-ai/cordis';
import { createElement, type ReactNode } from 'react';
import { BindPanelBody, useBindState, installPanelStyles } from './bind-page.ts';
import { ConfigPanel } from './config-panel.ts';

export const name = 'qqterm-client';
export const inject = ['slots'];

/** ui-slots 的席位系统服务（局部投影） */
interface SlotsLike {
  inject(slotName: string, register: () => (() => void)): () => void;
  register(spec: Record<string, unknown>, component: unknown): () => void;
}

/** 设置页栏目：共享一份绑定状态轮询，驱动绑定面板与配置刷新 */
function QQBotSettingsSection(): ReactNode {
  const { state, gone, recheck } = useBindState();
  return createElement('div', null,
    BindPanelBody({ state, gone, recheck }),
    ConfigPanel({ bindPhase: state?.phase }),
  );
}

export function apply(ctx: Context): void {
  // 面板样式全局安装：面板内渲染的元素需要可见
  installPanelStyles();
  const slots = (ctx as unknown as { slots: SlotsLike }).slots;
  (ctx as unknown as { effect(fn: () => () => void, name?: string): void }).effect(
    () => slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'qqterm', order: 7, label: 'QQ 超级终端' },
      QQBotSettingsSection,
    )),
    'qqterm-client.binding',
  );
}
