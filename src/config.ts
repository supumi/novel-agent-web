/**
 * 应用配置文件
 * 统一管理应用名称和其他全局配置
 */

export const APP_CONFIG = {
  /** 应用名称 */
  name: '小说创作助手',
  
  /** 应用名称首字母（用于 Logo） */
  nameInitial: '小',
  
  /** 应用描述 */
  description: '续写下一章 · 记忆卡 · 钩子压力 · 一致性校验 · AI 痕迹体检',
  
  /** 版本号 */
  version: '1.0.0',
};

/**
 * 模型白名单：模型下拉只显示这里列出的 modelId。
 * 留空数组 = 不限制（显示全部）。可在「设置 → 模型白名单」里勾选修改。
 *
 * 注意：现在模型来自用户自己填的 API Key（每人不同），
 * 所以默认**不限制**，让每个人都能看到自己账号下真实可用的模型。
 */
export const DEFAULT_MODEL_ALLOWLIST: string[] = [];

/** 模型白名单在 localStorage 中的键 */
export const MODEL_ALLOWLIST_KEY = 'modelAllowlist';

export default APP_CONFIG;
