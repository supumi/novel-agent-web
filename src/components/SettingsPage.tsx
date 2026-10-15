import { useState, useEffect, useCallback } from 'react';
import { 
  Form, 
  Input, 
  Textarea, 
  Button, 
  Tooltip,
  Popconfirm,
  MessagePlugin,
  Loading,
  Link,
  Tag,
  Select,
  Checkbox
} from 'tdesign-react';
import { 
  AddIcon, 
  EditIcon, 
  DeleteIcon,
  CheckIcon,
  CheckCircleFilledIcon,
  CloseCircleFilledIcon,
  RefreshIcon
} from 'tdesign-icons-react';
import { Bot, Sparkles, Code, FileText, Globe, Lightbulb } from 'lucide-react';
import { CustomAgent, Model, PermissionMode } from '../types';
import { LlmConfig, clearLlm, getIdentityToken, getLlm, resetIdentity } from '../lib/api';

interface SettingsPageProps {
  agents: CustomAgent[];
  onAdd: (agent: Omit<CustomAgent, 'id' | 'createdAt' | 'updatedAt'>) => CustomAgent;
  onUpdate: (id: string, updates: Partial<Omit<CustomAgent, 'id' | 'createdAt'>>) => void;
  onDelete: (id: string) => void;
  /** 后端返回的全部模型 */
  allModels: Model[];
  /** 当前模型白名单（空数组 = 显示全部） */
  allowlist: string[];
  /** 更新模型白名单 */
  onSetAllowlist: (next: string[]) => void;
  /** 重新拉取模型列表 */
  onRefreshModels: () => void;
}

function maskKey(k: string): string {
  if (!k) return '（未填写）';
  if (k.length <= 10) return k.slice(0, 3) + '****';
  return k.slice(0, 6) + '****' + k.slice(-4);
}

const PRESET_ICONS = [
  { name: 'Bot', icon: Bot },
  { name: 'Sparkles', icon: Sparkles },
  { name: 'Code', icon: Code },
  { name: 'FileText', icon: FileText },
  { name: 'Globe', icon: Globe },
  { name: 'Lightbulb', icon: Lightbulb },
];

const PRESET_COLORS = [
  '#0052d9', '#0594fa', '#00a870', '#ed7b2f', 
  '#e34d59', '#a25eb5', '#5c6bc0', '#26a69a'
];

const PERMISSION_MODES: { value: PermissionMode; label: string; description: string }[] = [
  { value: 'default', label: 'default', description: '默认模式，所有操作需确认' },
  { value: 'acceptEdits', label: 'acceptEdits', description: '自动批准文件编辑，Bash 仍需确认' },
  { value: 'plan', label: 'plan', description: '规划模式，仅允许读取操作' },
  { value: 'bypassPermissions', label: 'bypassPermissions', description: '跳过所有权限检查（谨慎使用）' },
];

const PRESET_TEMPLATES = [
  {
    name: '代码助手',
    description: '专注于编程和代码相关任务',
    systemPrompt: '你是一个专业的编程助手。你擅长编写、审查和解释代码。请提供清晰、高效且符合最佳实践的代码解决方案。在解释时，请考虑代码的可读性、性能和可维护性。',
    icon: 'Code',
    color: '#0594fa',
  },
  {
    name: '写作助手',
    description: '帮助撰写和优化各类文档',
    systemPrompt: '你是一个专业的写作助手。你擅长撰写、编辑和优化各类文档，包括文章、报告、邮件等。请帮助用户提升文字表达的清晰度、逻辑性和吸引力。',
    icon: 'FileText',
    color: '#00a870',
  },
  {
    name: '翻译助手',
    description: '提供高质量的多语言翻译',
    systemPrompt: '你是一个专业的翻译助手。你精通多种语言，能够提供准确、自然、符合语境的翻译。请在翻译时保持原文的语气和风格，同时确保目标语言的地道表达。',
    icon: 'Globe',
    color: '#ed7b2f',
  },
  {
    name: '创意助手',
    description: '激发灵感，提供创意建议',
    systemPrompt: '你是一个富有创意的助手。你善于头脑风暴、提供创新想法和独特视角。请帮助用户突破思维定式，探索新的可能性，激发创造力。',
    icon: 'Lightbulb',
    color: '#a25eb5',
  },
];

export function SettingsPage({ 
  agents, 
  onAdd, 
  onUpdate, 
  onDelete,
  allModels,
  allowlist,
  onSetAllowlist,
  onRefreshModels,
}: SettingsPageProps) {
  const [editingAgent, setEditingAgent] = useState<CustomAgent | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    systemPrompt: '',
    icon: 'Bot',
    color: '#0052d9',
    permissionMode: 'default' as PermissionMode,
  });
  
  // 当前模型配置（存在 localStorage）
  const [llm, setLlmState] = useState<LlmConfig | null>(() => getLlm());
  const [identity, setIdentity] = useState('');

  const handleReconfigure = () => {
    clearLlm();
    setLlmState(null);
    window.location.reload();
  };

  /**
   * 换身份：只清本地身份码，**不动模型配置**。
   * 两者是独立的东西 —— API Key 属于这台浏览器，跟小说数据归谁没有关系，
   * 为了换身份逼用户重新填一次 key 是没必要的。
   * 清掉身份码后刷新，会重新走一次「认领本机历史数据」的流程：
   * 若这台机器还有没被认领的旧数据，会自动继承过来。
   */
  const handleSwitchIdentity = () => {
    resetIdentity();
    window.location.reload();
  };

  useEffect(() => {
    setIdentity((getIdentityToken() || '').slice(0, 8));
  }, []);

  const resetForm = () => {
    setFormData({
      name: '',
      description: '',
      systemPrompt: '',
      icon: 'Bot',
      color: '#0052d9',
      permissionMode: 'default',
    });
    setEditingAgent(null);
    setIsCreating(false);
  };

  const handleEdit = (agent: CustomAgent) => {
    if (agent.id === 'default') return;
    setEditingAgent(agent);
    setFormData({
      name: agent.name,
      description: agent.description || '',
      systemPrompt: agent.systemPrompt,
      icon: agent.icon || 'Bot',
      color: agent.color || '#0052d9',
      permissionMode: agent.permissionMode || 'default',
    });
    setIsCreating(true);
  };

  const handleSave = () => {
    if (!formData.name.trim() || !formData.systemPrompt.trim()) {
      MessagePlugin.warning('请填写名称和系统提示词');
      return;
    }

    if (editingAgent) {
      onUpdate(editingAgent.id, formData);
      MessagePlugin.success('Agent 已更新');
    } else {
      onAdd(formData);
      MessagePlugin.success('Agent 已创建');
    }
    resetForm();
  };

  const handleUseTemplate = (template: typeof PRESET_TEMPLATES[0]) => {
    setFormData({
      ...template,
      description: template.description,
      permissionMode: 'default' as PermissionMode,
    });
    setIsCreating(true);
  };

  const handleDelete = (id: string) => {
    onDelete(id);
    MessagePlugin.success('Agent 已删除');
  };

  const getIconComponent = (iconName: string) => {
    const preset = PRESET_ICONS.find(p => p.name === iconName);
    return preset ? preset.icon : Bot;
  };

  const customAgents = agents.filter(a => a.id !== 'default');

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-3xl mx-auto space-y-8">
        {/* 页面标题 */}
        <div>
          <h1 
            className="text-2xl font-semibold mb-2"
            style={{ color: 'var(--td-text-color-primary)' }}
          >
            设置
          </h1>
          <p style={{ color: 'var(--td-text-color-secondary)' }}>
            管理登录配置和自定义 Agent
          </p>
        </div>

        {/* 模型配置 */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2
                className="text-lg font-medium"
                style={{ color: 'var(--td-text-color-primary)' }}
              >
                模型配置
              </h2>
              <p
                className="text-sm mt-1"
                style={{ color: 'var(--td-text-color-secondary)' }}
              >
                你自己填的大模型接口。凭据只存在这台设备的浏览器里，不会上传到服务器。
              </p>
            </div>
            <Tag size="small" variant="outline" theme={llm ? 'success' : 'warning'}>
              {llm ? '已配置' : '未配置'}
            </Tag>
          </div>

          {llm ? (
            <div className="space-y-2 mb-5">
              {[
                ['接入方式', llm.protocol === 'codebuddy' ? '本机 CodeBuddy 登录' : 'OpenAI 兼容接口'],
                ...(llm.protocol === 'openai'
                  ? [
                      ['Base URL', llm.baseUrl],
                      ['API Key', maskKey(llm.apiKey)],
                    ]
                  : []),
                ['模型', llm.model || '（用默认模型）'],
              ].map(([k, v]) => (
                <div key={k} className="flex items-start gap-4 text-sm">
                  <span
                    className="shrink-0"
                    style={{ width: '84px', color: 'var(--td-text-color-placeholder)' }}
                  >
                    {k}
                  </span>
                  <span
                    className="font-mono break-all"
                    style={{ color: 'var(--td-text-color-primary)' }}
                  >
                    {v}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm mb-5" style={{ color: 'var(--td-text-color-secondary)' }}>
              还没有配置模型，请刷新页面重新填写。
            </p>
          )}

          <div className="flex items-center gap-2">
            <Button size="small" theme="primary" variant="outline" onClick={handleReconfigure}>
              重新配置模型
            </Button>
            <Popconfirm
              theme="danger"
              content="会换一个全新身份，当前身份下的作品将不再可见（服务端数据仍在，但无法再访问）。若这台机器还有未被认领的历史数据，刷新后会自动继承。确定吗？"
              onConfirm={handleSwitchIdentity}
            >
              <Button size="small" variant="text">
                更换身份
              </Button>
            </Popconfirm>
          </div>

          <div
            className="mt-5 p-3 rounded-lg text-xs leading-relaxed space-y-1"
            style={{
              backgroundColor: 'var(--td-bg-color-secondarycontainer)',
              color: 'var(--td-text-color-secondary)',
            }}
          >
            <div style={{ color: 'var(--td-text-color-primary)', fontWeight: 500 }}>
              当前身份码：<code>{identity || '（未生成）'}…</code>
            </div>
            <div>
              你的小说、设定、聊天记录都存在服务端一个只属于这个身份码的目录里。
              服务端只保存它的哈希值，无法反推、无法冒充，也看不到别人的数据。
            </div>
            <div>
              注意：身份码存在浏览器本地，清空浏览器数据就会丢失，作品请及时用「导出」保存。
            </div>
            <div>
              看不到以前的本地作品？点「更换身份」刷新一次 —— 这台机器上还没被认领的历史数据
              会自动继承过来（模型配置不会丢）。
            </div>
          </div>
        </div>

        <div 
          style={{ 
            height: '1px', 
            backgroundColor: 'var(--td-component-border)' 
          }} 
        />

        {/* 模型白名单 */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 
                className="text-lg font-medium"
                style={{ color: 'var(--td-text-color-primary)' }}
              >
                模型白名单
              </h2>
              <p 
                className="text-sm mt-1"
                style={{ color: 'var(--td-text-color-secondary)' }}
              >
                只在下拉里显示勾选的模型；一个都不勾 = 显示全部
              </p>
            </div>
            <div className="flex items-center gap-1">
              <Button 
                variant="text" 
                size="small"
                onClick={() => onSetAllowlist([])}
                disabled={allowlist.length === 0}
              >
                显示全部
              </Button>
              <Button 
                variant="text" 
                size="small"
                icon={<RefreshIcon />}
                onClick={onRefreshModels}
              >
                刷新
              </Button>
            </div>
          </div>

          {allModels.length === 0 ? (
            <div 
              className="text-sm p-4 rounded-lg"
              style={{ 
                color: 'var(--td-text-color-placeholder)',
                backgroundColor: 'var(--td-bg-color-component)'
              }}
            >
              还没拿到模型列表，点右上角「刷新」重试
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              {allModels.map(model => (
                <Checkbox
                  key={model.modelId}
                  checked={allowlist.includes(model.modelId)}
                  onChange={(checked) => {
                    const next = checked
                      ? Array.from(new Set([...allowlist, model.modelId]))
                      : allowlist.filter(id => id !== model.modelId);
                    onSetAllowlist(next);
                  }}
                  label={
                    <span className="text-sm">
                      {model.name}
                      <span 
                        className="ml-2 text-xs font-mono"
                        style={{ color: 'var(--td-text-color-placeholder)' }}
                      >
                        {model.modelId}
                      </span>
                    </span>
                  }
                />
              ))}
            </div>
          )}

          <p 
            className="text-xs mt-3"
            style={{ color: 'var(--td-text-color-placeholder)' }}
          >
            当前白名单：
            {allowlist.length === 0 ? '（空 = 全部显示）' : allowlist.join('、')}
          </p>
        </div>

        <div 
          style={{ 
            height: '1px', 
            backgroundColor: 'var(--td-component-border)' 
          }} 
        />

        {/* Agent 配置 */}
        <div>
          <div className="mb-4">
            <h2 
              className="text-lg font-medium"
              style={{ color: 'var(--td-text-color-primary)' }}
            >
              Agent 配置
            </h2>
            <p 
              className="text-sm mt-1"
              style={{ color: 'var(--td-text-color-secondary)' }}
            >
              创建和管理自定义 Agent
            </p>
          </div>

          <div className="space-y-6">
              {/* 创建/编辑表单 */}
              {isCreating ? (
                <div 
                  className="p-5 rounded-xl border"
                  style={{ 
                    backgroundColor: 'var(--td-bg-color-container)',
                    borderColor: 'var(--td-component-border)'
                  }}
                >
                  <div className="space-y-4">
                    <div className="flex justify-between items-center mb-2">
                      <h4 className="text-base font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
                        {editingAgent ? '编辑 Agent' : '创建新 Agent'}
                      </h4>
                      <Button variant="text" onClick={resetForm}>取消</Button>
                    </div>
                    
                    <Form labelAlign="top">
                      <Form.FormItem label="名称" requiredMark>
                        <Input 
                          value={formData.name}
                          onChange={(v) => setFormData(prev => ({ ...prev, name: v as string }))}
                          placeholder="例如：代码助手"
                        />
                      </Form.FormItem>
                      
                      <Form.FormItem label="描述">
                        <Input 
                          value={formData.description}
                          onChange={(v) => setFormData(prev => ({ ...prev, description: v as string }))}
                          placeholder="简短描述这个 Agent 的用途"
                        />
                      </Form.FormItem>
                      
                      <Form.FormItem label="图标和颜色">
                        <div className="flex gap-4">
                          <div className="flex gap-2">
                            {PRESET_ICONS.map(({ name, icon: Icon }) => (
                              <button
                                key={name}
                                type="button"
                                className="w-9 h-9 rounded-lg flex items-center justify-center transition-all border-2"
                                style={{
                                  backgroundColor: formData.icon === name ? formData.color : 'transparent',
                                  color: formData.icon === name ? 'white' : 'var(--td-text-color-secondary)',
                                  borderColor: formData.icon === name ? formData.color : 'var(--td-component-border)',
                                }}
                                onClick={() => setFormData(prev => ({ ...prev, icon: name }))}
                              >
                                <Icon size={18} />
                              </button>
                            ))}
                          </div>
                          <div className="flex gap-1.5 items-center">
                            {PRESET_COLORS.map(color => (
                              <button
                                key={color}
                                type="button"
                                className="w-7 h-7 rounded-full flex items-center justify-center transition-transform hover:scale-110"
                                style={{ backgroundColor: color }}
                                onClick={() => setFormData(prev => ({ ...prev, color }))}
                              >
                                {formData.color === color && <CheckIcon style={{ color: 'white' }} size="14px" />}
                              </button>
                            ))}
                          </div>
                        </div>
                      </Form.FormItem>
                      
                      <Form.FormItem label="权限模式">
                        <Select
                          value={formData.permissionMode}
                          onChange={(v) => setFormData(prev => ({ ...prev, permissionMode: v as PermissionMode }))}
                          style={{ width: '100%' }}
                        >
                          {PERMISSION_MODES.map(mode => (
                            <Select.Option key={mode.value} value={mode.value} label={mode.label}>
                              <div className="flex flex-col py-1">
                                <span className="font-mono text-sm" style={{ color: 'var(--td-success-color)' }}>
                                  {mode.label}
                                </span>
                                <span className="text-xs" style={{ color: 'var(--td-text-color-placeholder)' }}>
                                  {mode.description}
                                </span>
                              </div>
                            </Select.Option>
                          ))}
                        </Select>
                      </Form.FormItem>
                      
                      <Form.FormItem label="系统提示词" requiredMark>
                        <Textarea 
                          value={formData.systemPrompt}
                          onChange={(v) => setFormData(prev => ({ ...prev, systemPrompt: v as string }))}
                          placeholder="定义 Agent 的行为和能力..."
                          autosize={{ minRows: 4, maxRows: 8 }}
                        />
                      </Form.FormItem>
                    </Form>
                    
                    <div className="flex justify-end gap-2 pt-2">
                      <Button variant="outline" onClick={resetForm}>取消</Button>
                      <Button theme="primary" onClick={handleSave}>
                        {editingAgent ? '保存修改' : '创建 Agent'}
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  {/* 快速模板 */}
                  <div>
                    <h4 className="text-sm font-medium mb-3" style={{ color: 'var(--td-text-color-secondary)' }}>
                      快速创建
                    </h4>
                    <div className="grid grid-cols-2 gap-3">
                      {PRESET_TEMPLATES.map(template => {
                        const Icon = getIconComponent(template.icon);
                        return (
                          <div 
                            key={template.name} 
                            className="p-3 rounded-lg cursor-pointer transition-all hover:shadow-md"
                            style={{ backgroundColor: 'var(--td-bg-color-component)' }}
                            onClick={() => handleUseTemplate(template)}
                          >
                            <div className="flex items-center gap-3">
                              <div 
                                className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
                                style={{ backgroundColor: template.color }}
                              >
                                <Icon size={20} color="white" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="font-medium truncate" style={{ color: 'var(--td-text-color-primary)' }}>
                                  {template.name}
                                </div>
                                <div className="text-xs truncate" style={{ color: 'var(--td-text-color-placeholder)' }}>
                                  {template.description}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* 自定义创建按钮 */}
                  <Button 
                    icon={<AddIcon />} 
                    variant="dashed" 
                    block 
                    onClick={() => setIsCreating(true)}
                  >
                    从头创建 Agent
                  </Button>

                  {/* 已有的自定义 Agent */}
                  {customAgents.length > 0 && (
                    <div>
                      <h4 className="text-sm font-medium mb-3" style={{ color: 'var(--td-text-color-secondary)' }}>
                        我的 Agent ({customAgents.length})
                      </h4>
                      <div className="space-y-2">
                        {customAgents.map(agent => {
                          const Icon = getIconComponent(agent.icon || 'Bot');
                          return (
                            <div 
                              key={agent.id} 
                              className="p-3 rounded-lg"
                              style={{ backgroundColor: 'var(--td-bg-color-component)' }}
                            >
                              <div className="flex items-center gap-3">
                                <div 
                                  className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
                                  style={{ backgroundColor: agent.color || '#0052d9' }}
                                >
                                  <Icon size={20} color="white" />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="font-medium" style={{ color: 'var(--td-text-color-primary)' }}>
                                    {agent.name}
                                  </div>
                                  <div className="text-xs truncate" style={{ color: 'var(--td-text-color-placeholder)' }}>
                                    {agent.description || agent.systemPrompt.slice(0, 50) + '...'}
                                  </div>
                                </div>
                                <div className="flex gap-1">
                                  <Tooltip content="编辑">
                                    <Button 
                                      variant="text" 
                                      shape="circle" 
                                      size="small"
                                      icon={<EditIcon />}
                                      onClick={() => handleEdit(agent)}
                                    />
                                  </Tooltip>
                                  <Popconfirm
                                    content="确定删除这个 Agent 吗？"
                                    onConfirm={() => handleDelete(agent.id)}
                                  >
                                    <Tooltip content="删除">
                                      <Button 
                                        variant="text" 
                                        shape="circle" 
                                        size="small"
                                        icon={<DeleteIcon />}
                                      />
                                    </Tooltip>
                                  </Popconfirm>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
        </div>
      </div>
    </div>
  );
}
