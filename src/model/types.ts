/**
 * 模型路由层类型定义
 */

/** 模型路由 */
export interface ModelRoute {
  provider: string;
  model: string;
}

/** 模型信息条目 */
export interface ModelEntry {
  provider: string;
  id: string;
  name?: string;
}

/** 思考强度档位（宿主 adapter 提供的元数据） */
export interface EffortOption {
  id: string;
  name: string;
  description?: string;
}

/** 某模型的思考强度元数据（档位 + 模型默认值） */
export interface ReasoningInfo {
  efforts: EffortOption[];
  defaultEffort?: string;
}
