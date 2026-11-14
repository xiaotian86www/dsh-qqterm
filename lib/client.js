window.__ModuleLoader__.load({
	id: "dsh-qqterm",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/shared/bind-protocol.ts
		/**
		* 端内绑定协议 —— 宿主路由与客户端面板的共享契约
		*
		* 类型与路径常量的唯一事实源：宿主（setup/bind-routes.ts）与浏览器
		* （client/bind-page.ts）各自 import，杜绝两端协议漂移。
		* 本模块必须保持纯类型 + 纯常量（零 node 依赖、零副作用）：
		* 客户端 tsdown 构建会将其内联进 bundle。
		*/
		/** 状态查询（绑定页轮询） */
		const BIND_STATE_PATH = "/qqterm/bind";
		/** 刷新二维码（绑定页按钮） */
		const BIND_REFRESH_PATH = "/qqterm/bind/refresh";
		/** 手动填写/编辑凭据（绑定页表单） */
		const BIND_MANUAL_PATH = "/qqterm/bind/manual";
		/** 解绑：移除已保存凭据，回到绑定流程 */
		const BIND_UNBIND_PATH = "/qqterm/bind/unbind";
		/** 配置读写（设置面板表单） */
		const BIND_CONFIG_PATH = "/qqterm/config";
		//#endregion
		//#region src/client/bind-page.ts
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
		/** 轮询间隔（毫秒）：活跃轮询 / 失败退避 */
		const ACTIVE_POLL_MS = 2e3;
		const RETRY_POLL_MS = 3e3;
		/** 样式注入标记（幂等） */
		const STYLE_ID$1 = "qqterm-bind-panel-styles";
		/**
		* 注入面板样式（全局一次，幂等）。交互态（hover/active/focus）无法用 inline
		* style 表达，统一收敛到类；DSW 主题变量缺失时用中性值兜底。
		* 插件激活时即安装：插件详情按钮渲染在面板之外，需提前可见；
		* 安装后不再随挂载移除，避免多个展示位互相清掉样式。
		*/
		function installPanelStyles() {
			if (typeof document === "undefined") return;
			if (document.getElementById(STYLE_ID$1) !== null) return;
			const style = document.createElement("style");
			style.id = STYLE_ID$1;
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
		function usePanelStyles() {
			(0, react.useEffect)(() => {
				installPanelStyles();
			}, []);
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
		function useBindState(enabled = true) {
			const [state, setState] = (0, react.useState)(null);
			const [gone, setGone] = (0, react.useState)(false);
			const recheckRef = (0, react.useRef)(() => {});
			(0, react.useEffect)(() => {
				if (!enabled) return;
				let stopped = false;
				let sawRoute = false;
				let generation = 0;
				let running = false;
				let restartAfterFlight = false;
				let urgentUntil = 0;
				let timer;
				const schedule = (ms) => {
					timer = setTimeout(() => {
						tick();
					}, ms);
				};
				const intervalFor = (phase) => {
					const base = phase === "saving" ? 500 : phase === "bound" ? 3e4 : ACTIVE_POLL_MS;
					return Date.now() < urgentUntil ? Math.min(base, ACTIVE_POLL_MS) : base;
				};
				const tick = async () => {
					if (stopped || running) return;
					running = true;
					const myGeneration = generation;
					const alive = () => myGeneration === generation && !stopped;
					try {
						const res = await fetch(BIND_STATE_PATH, { cache: "no-store" });
						if (res.status === 404) {
							if (!stopped && !sawRoute) setGone(true);
							else if (alive()) schedule(Date.now() < urgentUntil ? 1e3 : 3e3);
							return;
						}
						if (!res.ok) {
							if (alive()) schedule(RETRY_POLL_MS);
							return;
						}
						sawRoute = true;
						const body = await res.json();
						if (!alive()) return;
						setState(body);
						schedule(intervalFor(body.phase));
						return;
					} catch {} finally {
						running = false;
						if (restartAfterFlight && !stopped) {
							restartAfterFlight = false;
							tick();
						}
					}
					if (alive()) schedule(RETRY_POLL_MS);
				};
				recheckRef.current = () => {
					generation += 1;
					urgentUntil = Date.now() + 15e3;
					if (timer !== void 0) clearTimeout(timer);
					if (running) {
						restartAfterFlight = true;
						return;
					}
					tick();
				};
				tick();
				return () => {
					stopped = true;
					if (timer !== void 0) clearTimeout(timer);
				};
			}, []);
			return {
				state,
				gone,
				recheck: (0, react.useCallback)(() => {
					recheckRef.current();
				}, [])
			};
		}
		/** 手动提交凭据（填写 / 更换共用）；owner 留空表示保留现有绑定用户 */
		async function submitManualCredentials(appId, appSecret, owner) {
			try {
				const res = await fetch(BIND_MANUAL_PATH, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						appId,
						appSecret,
						owner
					})
				});
				const body = await res.json().catch(() => ({}));
				if (res.ok && body.ok) return {
					ok: true,
					message: body.message
				};
				return {
					ok: false,
					error: body.error ?? `保存失败（HTTP ${res.status}）`
				};
			} catch (err) {
				return {
					ok: false,
					error: err instanceof Error ? err.message : String(err)
				};
			}
		}
		/**
		* 手动凭据表单（填写 / 更换共用）。
		*
		* appSecret 永不回显（占位符提示），提交成功后展示保存结果；
		* 宿主写入 profile patch 并经 HMR 重载，状态轮询随后收敛为 bound。
		*/
		function ManualForm({ initialAppId }) {
			const [appId, setAppId] = (0, react.useState)(initialAppId ?? "");
			const [appSecret, setAppSecret] = (0, react.useState)("");
			const [owner, setOwner] = (0, react.useState)("");
			const [busy, setBusy] = (0, react.useState)(false);
			const [result, setResult] = (0, react.useState)(null);
			const submit = (0, react.useCallback)((event) => {
				event.preventDefault();
				if (busy) return;
				const trimmedId = appId.trim();
				const trimmedSecret = appSecret.trim();
				if (trimmedId.length === 0 || trimmedSecret.length === 0) {
					setResult({
						ok: false,
						error: "appId 与 appSecret 均为必填"
					});
					return;
				}
				setBusy(true);
				submitManualCredentials(trimmedId, trimmedSecret, owner.trim()).then((outcome) => {
					setResult(outcome);
					setBusy(false);
				});
			}, [
				appId,
				appSecret,
				owner,
				busy
			]);
			if (result !== null && result.ok) return (0, react.createElement)("div", { className: "qqterm-bind-status" }, (0, react.createElement)("div", { className: "qqterm-bind-status-row" }, (0, react.createElement)("div", { className: "qqterm-bind-status-icon" }, "✅"), (0, react.createElement)("div", { className: "qqterm-bind-status-meta" }, (0, react.createElement)("p", { className: "qqterm-bind-status-title" }, result.message ?? "凭据已保存"), (0, react.createElement)("p", { className: "qqterm-bind-status-sub" }, "插件将自动重载；未填允许的用户时需在设置里补填 OpenID"))));
			return (0, react.createElement)("form", {
				className: "qqterm-bind-form",
				onSubmit: submit
			}, (0, react.createElement)("label", { className: "qqterm-bind-field" }, "AppID", (0, react.createElement)("input", {
				className: "qqterm-bind-input",
				value: appId,
				placeholder: "QQ 机器人 AppID",
				onChange: (event) => {
					setAppId(event.currentTarget.value);
				},
				autoComplete: "off",
				spellCheck: false
			})), (0, react.createElement)("label", { className: "qqterm-bind-field" }, "AppSecret", (0, react.createElement)("input", {
				className: "qqterm-bind-input",
				type: "password",
				value: appSecret,
				placeholder: initialAppId === void 0 ? "QQ 机器人 AppSecret" : "输入新的 AppSecret（不回显）",
				onChange: (event) => {
					setAppSecret(event.currentTarget.value);
				},
				autoComplete: "new-password"
			})), (0, react.createElement)("label", { className: "qqterm-bind-field" }, "允许的用户", (0, react.createElement)("input", {
				className: "qqterm-bind-input",
				value: owner,
				placeholder: "QQ OpenID（可留空，之后在设置里填）",
				onChange: (event) => {
					setOwner(event.currentTarget.value);
				},
				autoComplete: "off",
				spellCheck: false
			})), result !== null && !result.ok ? (0, react.createElement)("p", { className: "qqterm-bind-error" }, result.error) : null, (0, react.createElement)("button", {
				className: "qqterm-bind-btn qqterm-bind-btn--primary",
				type: "submit",
				disabled: busy
			}, busy ? "正在保存…" : "保存"));
		}
		/** QQ 机器人 logo 路径（assets/icons/qqbot_logo.svg，内嵌以保持 bundle 自包含） */
		const QQ_BOT_LOGO_PATH = "M19.3862 15.5001C19.3861 11.4203 16.0789 8.11296 11.999 8.11292C7.91915 8.11292 4.61203 11.4203 4.61182 15.5001V17.0001C4.61182 18.5949 5.90429 19.8873 7.49902 19.8873H16.499C18.0937 19.8873 19.3862 18.5949 19.3862 17.0001V15.5001ZM10.6118 14.0001C10.6118 14.6145 10.1129 15.1134 9.49853 15.1134C8.8843 15.1132 8.38672 14.6144 8.38672 14.0001V12.0006C8.38672 11.3863 8.8843 10.8875 9.49853 10.8873C10.1129 10.8873 10.6118 11.3862 10.6118 12.0006V14.0001ZM15.6113 14.0001C15.6113 14.6143 15.1136 15.1131 14.4995 15.1134C13.8851 15.1134 13.3862 14.6145 13.3862 14.0001V12.0006C13.3862 11.3862 13.8851 10.8873 14.4995 10.8873C15.1136 10.8876 15.6113 11.3864 15.6113 12.0006V14.0001ZM14.2607 3.04895C14.2607 3.89351 13.7957 4.62474 13.1108 5.0133V5.95374C17.8958 6.50514 21.6112 10.5676 21.6113 15.5001V17.0001C21.6113 19.8237 19.3225 22.1124 16.499 22.1124H7.49902C4.67546 22.1124 2.38672 19.8237 2.38672 17.0001V15.5001C2.38691 10.568 6.10139 6.50571 10.8857 5.95374V5.01185C10.2017 4.62305 9.73583 3.89286 9.73583 3.04895C9.73609 1.79961 10.7496 0.787231 11.999 0.787231C13.2484 0.787297 14.2605 1.79966 14.2607 3.04895Z";
		/** QQ 机器人图标（logo 矢量渲染，透明底，随 size 缩放） */
		function QqBotIcon({ size = 28 }) {
			return (0, react.createElement)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				"aria-hidden": true,
				className: "qqterm-bind-qqicon"
			}, (0, react.createElement)("path", {
				d: QQ_BOT_LOGO_PATH,
				fill: "#0085FF"
			}));
		}
		/** 已绑定视图：回显 appId + 更换凭据 / 解绑入口 */
		function BoundView({ appId, recheck }) {
			const [editing, setEditing] = (0, react.useState)(false);
			const [unbindResult, setUnbindResult] = (0, react.useState)(null);
			const unbind = (0, react.useCallback)(() => {
				if (!window.confirm("确定解绑吗？\n解绑后机器人立即下线，插件将重新进入扫码绑定流程。")) return;
				fetch(BIND_UNBIND_PATH, { method: "POST" }).then(async (res) => {
					const body = await res.json().catch(() => ({}));
					if (res.ok && body.ok === true) {
						setUnbindResult({
							ok: true,
							message: body.message ?? "已解绑，插件将重载并重新进入绑定流程"
						});
						recheck();
						return;
					}
					setUnbindResult({
						ok: false,
						message: body.error ?? `解绑失败（HTTP ${res.status}）`
					});
				}).catch((err) => {
					setUnbindResult({
						ok: false,
						message: err instanceof Error ? err.message : String(err)
					});
				});
			}, [recheck]);
			if (unbindResult !== null) return (0, react.createElement)("div", { className: "qqterm-bind-status" }, (0, react.createElement)("div", { className: "qqterm-bind-status-row" }, (0, react.createElement)("div", { className: "qqterm-bind-status-icon" }, unbindResult.ok ? "👋" : "⚠️"), (0, react.createElement)("div", { className: "qqterm-bind-status-meta" }, (0, react.createElement)("p", { className: "qqterm-bind-status-title" }, unbindResult.message)), unbindResult.ok ? (0, react.createElement)("button", {
				className: "qqterm-bind-ghost",
				onClick: recheck
			}, "刷新状态") : (0, react.createElement)("button", {
				className: "qqterm-bind-ghost",
				onClick: () => {
					setUnbindResult(null);
				}
			}, "返回")));
			if (editing) return (0, react.createElement)("div", { className: "qqterm-bind-status" }, (0, react.createElement)("div", { className: "qqterm-bind-status-row" }, (0, react.createElement)("div", { className: "qqterm-bind-status-meta" }, (0, react.createElement)("p", { className: "qqterm-bind-status-title" }, "更换凭据")), (0, react.createElement)("button", {
				className: "qqterm-bind-ghost",
				onClick: () => {
					setEditing(false);
				}
			}, "返回")), (0, react.createElement)(ManualForm, { initialAppId: appId }));
			return (0, react.createElement)("div", { className: "qqterm-bind-status" }, (0, react.createElement)("div", { className: "qqterm-bind-status-row" }, (0, react.createElement)(QqBotIcon, { size: 28 }), (0, react.createElement)("div", { className: "qqterm-bind-status-meta" }, (0, react.createElement)("p", { className: "qqterm-bind-status-title" }, "已绑定"), (0, react.createElement)("p", { className: "qqterm-bind-status-sub qqterm-bind-mono" }, `AppID ${appId} · 私聊已接入`))), (0, react.createElement)("div", { className: "qqterm-bind-status-actions" }, (0, react.createElement)("button", {
				className: "qqterm-bind-btn qqterm-bind-btn--primary",
				onClick: () => {
					setEditing(true);
				}
			}, "更换凭据"), (0, react.createElement)("button", {
				className: "qqterm-bind-btn qqterm-bind-btn--danger",
				onClick: unbind
			}, "解绑")));
		}
		/** 未绑定视图：扫码 / 手动填写切换 */
		function UnboundView({ state }) {
			const [mode, setMode] = (0, react.useState)("qr");
			const refresh = (0, react.useCallback)(() => {
				fetch(BIND_REFRESH_PATH, { method: "POST" }).catch(() => {});
			}, []);
			const [imgFailed, setImgFailed] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				setImgFailed(false);
			}, [state.qrSvg]);
			if (mode === "manual") return (0, react.createElement)("div", { className: "qqterm-bind-panel" }, (0, react.createElement)("p", { className: "qqterm-bind-title" }, "手动填写凭据"), (0, react.createElement)(ManualForm, {}), (0, react.createElement)("button", {
				className: "qqterm-bind-ghost",
				onClick: () => {
					setMode("qr");
				}
			}, "改用扫码绑定"));
			if (state.qrSvg === void 0 || imgFailed) return (0, react.createElement)("div", { className: "qqterm-bind-panel" }, (0, react.createElement)("div", { className: "qqterm-bind-icon" }, "⚠️"), (0, react.createElement)("p", { className: "qqterm-bind-title" }, "二维码暂时无法显示"), (0, react.createElement)("p", { className: "qqterm-bind-hint" }, "可重启应用后重试，或任选下面一种方式继续"), (0, react.createElement)("a", {
				href: state.url,
				target: "_blank",
				rel: "noreferrer noopener",
				className: "qqterm-bind-link"
			}, "在浏览器中打开链接扫码"), (0, react.createElement)("div", { className: "qqterm-bind-row" }, (0, react.createElement)("button", {
				className: "qqterm-bind-pill",
				onClick: () => {
					setMode("manual");
				}
			}, "手动填写凭据")));
			return (0, react.createElement)("div", { className: "qqterm-bind-panel" }, (0, react.createElement)("img", {
				src: state.qrSvg,
				alt: "QQ 扫码二维码",
				width: 220,
				height: 220,
				className: "qqterm-bind-qr",
				onError: () => {
					setImgFailed(true);
				}
			}), (0, react.createElement)("p", { className: "qqterm-bind-title" }, "扫码绑定 QQ 机器人"), (0, react.createElement)("p", { className: "qqterm-bind-hint" }, "使用手机 QQ 扫描二维码完成绑定"), (0, react.createElement)("a", {
				href: state.url,
				target: "_blank",
				rel: "noreferrer noopener",
				className: "qqterm-bind-link"
			}, "二维码显示异常？在浏览器中打开"), (0, react.createElement)("div", { className: "qqterm-bind-row" }, (0, react.createElement)("button", {
				className: "qqterm-bind-pill",
				onClick: refresh
			}, "刷新二维码"), (0, react.createElement)("button", {
				className: "qqterm-bind-pill",
				onClick: () => {
					setMode("manual");
				}
			}, "手动填写")));
		}
		/** 依据宿主相位渲染面板主体（可注入共享轮询结果避免双计时器） */
		function BindPanelBody(props = {}) {
			usePanelStyles();
			const injected = props?.state !== void 0;
			const internal = useBindState(!injected);
			const state = injected ? props.state ?? null : internal.state;
			const gone = injected ? props.gone ?? false : internal.gone;
			const recheck = injected ? props.recheck ?? (() => {}) : internal.recheck;
			const [lastQr, setLastQr] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				if (state === null) return;
				if (state.phase === "waiting") {
					if (state.qrSvg !== void 0) setLastQr(state.qrSvg);
				} else if (state.phase === "bound") setLastQr(null);
			}, [state]);
			if (gone) return (0, react.createElement)("div", { className: "qqterm-bind-panel" }, (0, react.createElement)("div", { className: "qqterm-bind-icon" }, "❔"), (0, react.createElement)("p", { className: "qqterm-bind-hint" }, "插件未启用，或当前版本不支持端内配置"));
			if (state === null || state.phase === "starting") return (0, react.createElement)("div", { className: "qqterm-bind-panel" }, (0, react.createElement)("p", { className: "qqterm-bind-hint" }, "正在获取绑定状态…"));
			if (state.phase === "saving") {
				if (lastQr !== null) return (0, react.createElement)("div", { className: "qqterm-bind-panel" }, (0, react.createElement)("div", { className: "qqterm-bind-scanned" }, (0, react.createElement)("img", {
					src: lastQr,
					alt: "QQ 扫码二维码",
					width: 220,
					height: 220,
					className: "qqterm-bind-scanned-qr"
				}), (0, react.createElement)("div", { className: "qqterm-bind-scanned-veil" }, (0, react.createElement)("p", { className: "qqterm-bind-scanned-title" }, "✅ 扫码成功"), (0, react.createElement)("p", { className: "qqterm-bind-scanned-sub" }, "正在连接机器人，稍候…"))));
				return (0, react.createElement)("div", { className: "qqterm-bind-status" }, (0, react.createElement)("div", { className: "qqterm-bind-status-row" }, (0, react.createElement)("div", { className: "qqterm-bind-status-icon" }, "🎉"), (0, react.createElement)("div", { className: "qqterm-bind-status-meta" }, (0, react.createElement)("p", { className: "qqterm-bind-status-title" }, "扫码成功"), (0, react.createElement)("p", { className: "qqterm-bind-status-sub" }, "凭据已保存，插件正在重载，稍后即可开始对话"))));
			}
			if (state.phase === "failed") return (0, react.createElement)("div", { className: "qqterm-bind-panel" }, (0, react.createElement)("div", { className: "qqterm-bind-icon" }, "⚠️"), (0, react.createElement)("p", { className: "qqterm-bind-title" }, "绑定失败"), (0, react.createElement)("p", { className: "qqterm-bind-hint" }, state.reason), (0, react.createElement)("div", { className: "qqterm-bind-row" }, (0, react.createElement)("button", {
				className: "qqterm-bind-btn qqterm-bind-btn--primary",
				onClick: () => {
					window.location.reload();
				}
			}, "重试")));
			if (state.phase === "bound") return (0, react.createElement)(BoundView, {
				appId: state.appId,
				recheck
			});
			return (0, react.createElement)(UnboundView, { state });
		}
		//#endregion
		//#region src/client/config-panel.ts
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
		/** 样式注入标记（幂等） */
		const STYLE_ID = "qqterm-config-panel-styles";
		/** DSW 通用设置风格（settings-form / Switch / SegmentedControl 原语复刻） */
		function useConfigPanelStyles() {
			(0, react.useEffect)(() => {
				if (typeof document === "undefined") return;
				if (document.getElementById(STYLE_ID) !== null) return;
				const style = document.createElement("style");
				style.id = STYLE_ID;
				style.textContent = `
.qqterm-config-form { display: flex; flex-direction: column; width: 100%; }
.qqterm-config-group-title {
  padding: 14px 0 2px; font-size: 12px; font-weight: 600; line-height: 18px;
  color: var(--dsw-alias-label-tertiary); text-transform: uppercase; letter-spacing: .04em;
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
				return () => {
					style.remove();
				};
			}, []);
		}
		/** 开关（官方 Switch 原语结构：aria-checked 驱动视觉态） */
		function Switch({ checked, label, onChange }) {
			return (0, react.createElement)("button", {
				type: "button",
				role: "switch",
				"aria-checked": checked,
				"aria-label": label,
				className: "qqterm-config-switch",
				onClick: () => {
					onChange(!checked);
				}
			}, (0, react.createElement)("span", { className: "qqterm-config-switch-thumb" }));
		}
		/** 开关行（label 左 + Switch 右 + 可选 help） */
		function SwitchRow({ label, help, checked, onChange }) {
			return (0, react.createElement)("div", { className: "qqterm-config-field" }, (0, react.createElement)("div", { className: "qqterm-config-head" }, (0, react.createElement)("span", { className: "qqterm-config-label" }, label), (0, react.createElement)(Switch, {
				checked,
				label,
				onChange
			})), help === void 0 ? null : (0, react.createElement)("p", { className: "qqterm-config-help" }, help));
		}
		/** 文本行（label 上 + 输入下，与官方 fields 布局一致） */
		function FieldRow({ label, help, value, placeholder, onChange }) {
			return (0, react.createElement)("div", { className: "qqterm-config-field" }, (0, react.createElement)("span", { className: "qqterm-config-label" }, label), (0, react.createElement)("input", {
				className: "qqterm-config-input",
				value,
				placeholder,
				spellCheck: false,
				onChange: (event) => {
					onChange(event.currentTarget.value);
				}
			}), help === void 0 ? null : (0, react.createElement)("p", { className: "qqterm-config-hint" }, help));
		}
		/** 深比较（表单值与初始回显值的 dirty 判断） */
		function shallowEqual(a, b) {
			return JSON.stringify(a) === JSON.stringify(b);
		}
		/**
		* 配置面板主体。
		*
		* 保存仅提交变更键（服务端按白名单合并），保存成功后提示
		* HMR 重载语义（进行中的机器人会话将重置）。
		*/
		function ConfigPanel(props = {}) {
			useConfigPanelStyles();
			const [initial, setInitial] = (0, react.useState)(null);
			const [form, setForm] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const [result, setResult] = (0, react.useState)(null);
			const [loadError, setLoadError] = (0, react.useState)(null);
			const bindPhase = props?.bindPhase;
			(0, react.useEffect)(() => {
				let stopped = false;
				fetch(BIND_CONFIG_PATH, { cache: "no-store" }).then(async (res) => {
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					const body = await res.json();
					if (stopped) return;
					setInitial(body.config);
					setForm(body.config);
				}).catch((err) => {
					if (!stopped) setLoadError(err instanceof Error ? err.message : String(err));
				});
				return () => {
					stopped = true;
				};
			}, [bindPhase]);
			const patch = (0, react.useCallback)((key, value) => {
				setForm((current) => current === null ? current : {
					...current,
					[key]: value
				});
				setResult(null);
			}, []);
			const submit = (0, react.useCallback)((event) => {
				event.preventDefault();
				if (busy || initial === null || form === null) return;
				const changed = {};
				for (const key of Object.keys(form)) if (!shallowEqual(form[key], initial[key])) changed[key] = form[key];
				if (Object.keys(changed).length === 0) return;
				setBusy(true);
				fetch(BIND_CONFIG_PATH, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(changed)
				}).then(async (res) => {
					const body = await res.json().catch(() => ({}));
					if (res.ok && body.ok === true) {
						setResult({
							ok: true,
							message: body.message ?? "配置已保存，插件将自动重载"
						});
						setInitial(form);
						return;
					}
					setResult({
						ok: false,
						message: body.error ?? `保存失败（HTTP ${res.status}）`
					});
				}).catch((err) => {
					setResult({
						ok: false,
						message: err instanceof Error ? err.message : String(err)
					});
				}).finally(() => {
					setBusy(false);
				});
			}, [
				busy,
				form,
				initial
			]);
			if (loadError !== null) return (0, react.createElement)("p", {
				className: "qqterm-config-hint",
				style: { padding: "12px 0" }
			}, `配置加载失败: ${loadError}`);
			if (initial === null || form === null) return (0, react.createElement)("p", {
				className: "qqterm-config-hint",
				style: { padding: "12px 0" }
			}, "正在加载配置…");
			const dirty = Object.keys(form).some((key) => !shallowEqual(form[key], initial[key]));
			const access = form.access ?? { owner: "" };
			return (0, react.createElement)("form", {
				className: "qqterm-config-form",
				onSubmit: submit
			}, (0, react.createElement)("div", { className: "qqterm-config-group-title" }, "服务范围"), (0, react.createElement)(FieldRow, {
				label: "允许的用户",
				help: "只允许这一个 QQ 用户；留空则拒绝所有人",
				placeholder: "QQ OpenID",
				value: access.owner,
				onChange: (v) => {
					patch("access", { owner: v });
				}
			}), (0, react.createElement)("div", { className: "qqterm-config-group-title" }, "基础设置"), (0, react.createElement)(SwitchRow, {
				label: "显示工具调用结果",
				checked: form.showToolResults ?? false,
				help: "在聊天中展示工具调用结果，含失败",
				onChange: (v) => {
					patch("showToolResults", v);
				}
			}), (0, react.createElement)("div", { className: "qqterm-config-footer" }, result !== null ? (0, react.createElement)("p", { className: `qqterm-config-note${result.ok ? " qqterm-config-note--ok" : " qqterm-config-note--error"}` }, (result.ok ? "" : "⚠️ ") + result.message) : dirty ? (0, react.createElement)("p", { className: "qqterm-config-note" }, "保存后插件将重载，进行中的机器人会话将重置") : (0, react.createElement)("p", { className: "qqterm-config-note" }), (0, react.createElement)("button", {
				className: "qqterm-config-save",
				type: "submit",
				disabled: busy || !dirty
			}, busy ? "正在保存…" : "保存")));
		}
		//#endregion
		//#region src/client/index.ts
		const name = "qqterm-client";
		const inject = ["slots"];
		/** 设置页栏目：共享一份绑定状态轮询，驱动绑定面板与配置刷新 */
		function QQBotSettingsSection() {
			const { state, gone, recheck } = useBindState();
			return (0, react.createElement)("div", null, BindPanelBody({
				state,
				gone,
				recheck
			}), ConfigPanel({ bindPhase: state?.phase }));
		}
		function apply(ctx) {
			installPanelStyles();
			const slots = ctx.slots;
			ctx.effect(() => slots.inject("settings.section", () => slots.register({
				name: "settings.section",
				id: "qqterm",
				order: 7,
				label: "QQ 超级终端"
			}, QQBotSettingsSection)), "qqterm-client.binding");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map