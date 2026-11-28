/**
 * 端内绑定协议 —— 宿主路由与客户端面板的共享契约
 *
 * 类型与路径常量的唯一事实源：宿主（setup/bind-routes.ts）与浏览器
 * （client/bind-page.ts）各自 import，杜绝两端协议漂移。
 * 本模块必须保持纯类型 + 纯常量（零 node 依赖、零副作用）：
 * 客户端 tsdown 构建会将其内联进 bundle。
 */

/** 状态查询（绑定页轮询） */
export const BIND_STATE_PATH = '/qqterm/bind';

/** 刷新二维码（绑定页按钮） */
export const BIND_REFRESH_PATH = '/qqterm/bind/refresh';

/** 手动填写/编辑凭据（绑定页表单） */
export const BIND_MANUAL_PATH = '/qqterm/bind/manual';

/** 解绑：移除已保存凭据，回到绑定流程 */
export const BIND_UNBIND_PATH = '/qqterm/bind/unbind';

/** 配置读写（设置面板表单） */
export const BIND_CONFIG_PATH = '/qqterm/config';

/** 单个 QQ 指令面板最多能放的命令数（平台限制，服务端截断与设置页勾选共用） */
export const PANEL_MAX_ITEMS = 20;

/** 指令面板设置页的命令目录项（服务端按唯一分组目录排序后下发） */
export interface PanelCommandWire {
  /** 命令主名，不带 `/` */
  name: string;
  description?: string;
  /** 展示分组；缺省表示未归类，设置页不显示组名并排在最后（分块与 QQ 面板排序共用） */
  group?: string;
}

/** 线上协议（HTTP 路由序列化形态） */
export type BindStateWire =
  | { phase: 'starting' }
  | { phase: 'waiting'; url: string; qrSvg?: string; issuedAt: number }
  | { phase: 'saving' }
  | { phase: 'failed'; reason: string }
  | { phase: 'bound'; appId: string };
