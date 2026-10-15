import { useState, useEffect, useCallback, useMemo } from 'react';
import { Model } from '../types';
import { DEFAULT_MODEL_ALLOWLIST, MODEL_ALLOWLIST_KEY } from '../config';
import { apiFetch, getLlm } from '../lib/api';

const STORAGE_KEY = 'defaultModel';

// 读取模型白名单（未设置过 → 用默认值）
function loadAllowlist(): string[] {
  try {
    const raw = localStorage.getItem(MODEL_ALLOWLIST_KEY);
    if (raw === null) return [...DEFAULT_MODEL_ALLOWLIST];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((x: unknown): x is string => typeof x === 'string');
    }
  } catch {
    // 解析失败则回退默认
  }
  return [...DEFAULT_MODEL_ALLOWLIST];
}

export function useModels() {
  // 后端返回的全部模型
  const [allModels, setAllModels] = useState<Model[]>([]);
  // 白名单（localStorage 持久化）
  const [allowlist, setAllowlistState] = useState<string[]>(loadAllowlist);
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    // 优先用配置向导里选定/验证过的模型
    return getLlm()?.model || localStorage.getItem(STORAGE_KEY) || '';
  });

  // 白名单过滤：空 = 显示全部；若勾选的模型当前都不可用则回退全部，避免下拉变空
  const models = useMemo(() => {
    if (allowlist.length === 0) return allModels;
    const filtered = allModels.filter(m => allowlist.includes(m.modelId));
    return filtered.length > 0 ? filtered : allModels;
  }, [allModels, allowlist]);

  const fetchModels = useCallback(async () => {
    try {
      const res = await apiFetch('/api/models');
      const data = await res.json();
      setAllModels(data.models || []);
    } catch (error) {
      console.error('Failed to fetch models:', error);
    }
  }, []);

  // 初始加载
  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  // 保证 selectedModel 始终在可选列表里（例如白名单改动后）
  useEffect(() => {
    if (models.length === 0) return;
    if (models.some(m => m.modelId === selectedModel)) return;
    const saved = localStorage.getItem(STORAGE_KEY);
    const next = saved && models.some(m => m.modelId === saved) ? saved : models[0].modelId;
    setSelectedModel(next);
    localStorage.setItem(STORAGE_KEY, next);
  }, [models, selectedModel]);

  // 更新白名单并持久化
  const setAllowlist = useCallback((next: string[]) => {
    setAllowlistState(next);
    localStorage.setItem(MODEL_ALLOWLIST_KEY, JSON.stringify(next));
  }, []);

  return {
    /** 白名单过滤后的模型（给下拉用） */
    models,
    /** 后端返回的全部模型（给设置页用） */
    allModels,
    /** 当前白名单 */
    allowlist,
    setAllowlist,
    selectedModel,
    setSelectedModel,
    fetchModels,
  };
}
