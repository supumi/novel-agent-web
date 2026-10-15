import { useState, useEffect, useMemo, useRef } from 'react';
import { APP_CONFIG } from '../config';
import {
  LlmConfig,
  LlmProtocol,
  apiGet,
  ensureIdentity,
  fetchLlmModels,
  testLlm,
} from '../lib/api';

/**
 * 首次使用配置向导
 * =================
 *
 * 这是「必须配置好一个模型才可以使用」的硬闸门：
 * 没有通过「测试连接」之前，「开始使用」按钮一直是禁用的，
 * 而且这个组件会盖住整个应用，没有任何关闭入口。
 *
 * 隐私说明也在这里讲清楚（用户最关心的那几句）。
 */

interface Preset {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
  hint: string;
}

/**
 * 快捷预设。
 *
 * 这里写死的是「示例模型名」，不是权威清单 —— 厂商改名的频率比这个文件更新得快
 * （DeepSeek 就把 deepseek-chat/deepseek-reasoner 换成了 deepseek-flash/deepseek-v4-pro）。
 * 所以：
 *   1. 填了 Key 之后会自动调一次「拉取列表」，用真实可用模型覆盖下面的 chips；
 *   2. chips 只是方便点一下，模型输入框永远可以手填任意名字（中转站的自定义名也认）。
 */
const PRESETS: Preset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    hint: '性价比高，写中文小说语感不错；老名字 deepseek-chat 部分中转站仍可用',
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-32k', 'moonshot-v1-128k'],
    hint: '长上下文，适合整章续写',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-plus', 'glm-4-air'],
    hint: '国内直连，中文表现稳',
  },
  {
    id: 'dashscope',
    label: '阿里通义',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-max'],
    hint: '兼容模式，模型选择多',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o'],
    hint: '需要海外网络',
  },
  {
    id: 'custom',
    label: '自定义',
    baseUrl: '',
    models: [],
    hint: '任何 OpenAI 兼容接口都行',
  },
];

// 少量内联样式（用 TDesign CSS 变量，自动跟随明暗主题）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const S: Record<string, any> = {
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 9999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--td-bg-color-page)',
    padding: '24px',
    overflowY: 'auto',
  },
  card: {
    width: '100%',
    maxWidth: '620px',
    background: 'var(--td-bg-color-container)',
    border: '1px solid var(--td-component-stroke)',
    borderRadius: '16px',
    padding: '32px',
    boxShadow: 'var(--td-shadow-2, 0 8px 32px rgba(0,0,0,0.12))',
    color: 'var(--td-text-color-primary)',
  },
  title: {
    fontSize: '22px',
    fontWeight: 600,
    marginBottom: '6px',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  sub: {
    fontSize: '13px',
    color: 'var(--td-text-color-secondary)',
    lineHeight: 1.7,
    marginBottom: '22px',
  },
  sectionLabel: {
    fontSize: '12px',
    fontWeight: 600,
    color: 'var(--td-text-color-secondary)',
    letterSpacing: '0.04em',
    marginBottom: '10px',
    textTransform: 'uppercase',
  },
  label: {
    display: 'block',
    fontSize: '13px',
    fontWeight: 500,
    marginBottom: '6px',
    color: 'var(--td-text-color-primary)',
  },
  input: {
    width: '100%',
    padding: '9px 12px',
    fontSize: '14px',
    borderRadius: '8px',
    border: '1px solid var(--td-component-stroke)',
    background: 'var(--td-bg-color-container)',
    color: 'var(--td-text-color-primary)',
    outline: 'none',
    fontFamily: 'inherit',
  },
  row: { marginBottom: '16px' },
  presetWrap: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '16px' },
  preset: (active: boolean): React.CSSProperties => ({
    padding: '7px 14px',
    fontSize: '13px',
    borderRadius: '999px',
    cursor: 'pointer',
    border: `1px solid ${active ? 'var(--td-brand-color)' : 'var(--td-component-stroke)'}`,
    background: active ? 'var(--td-brand-color-light)' : 'transparent',
    color: active ? 'var(--td-brand-color)' : 'var(--td-text-color-primary)',
    transition: 'all .15s',
    userSelect: 'none',
  }),
  protocol: (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: '14px',
    borderRadius: '10px',
    cursor: 'pointer',
    border: `1.5px solid ${active ? 'var(--td-brand-color)' : 'var(--td-component-stroke)'}`,
    background: active ? 'var(--td-brand-color-light)' : 'transparent',
    transition: 'all .15s',
    userSelect: 'none',
  }),
  btn: (primary: boolean, disabled: boolean): React.CSSProperties => ({
    padding: '10px 20px',
    fontSize: '14px',
    fontWeight: 500,
    borderRadius: '8px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    border: primary ? 'none' : '1px solid var(--td-component-stroke)',
    background: primary
      ? disabled
        ? 'var(--td-bg-color-component-disabled, #dcdcdc)'
        : 'var(--td-brand-color)'
      : 'transparent',
    color: primary ? 'var(--td-text-color-anti)' : 'var(--td-text-color-primary)',
    opacity: disabled ? 0.6 : 1,
    fontFamily: 'inherit',
  }),
  tip: {
    fontSize: '12px',
    color: 'var(--td-text-color-placeholder, var(--td-text-color-secondary))',
    marginTop: '6px',
    lineHeight: 1.6,
  },
  privacy: {
    marginTop: '24px',
    padding: '16px',
    borderRadius: '10px',
    background: 'var(--td-bg-color-secondarycontainer, var(--td-bg-color-component))',
    fontSize: '12.5px',
    lineHeight: 1.85,
    color: 'var(--td-text-color-secondary)',
  },
};

function resultBox(ok: boolean): React.CSSProperties {
  return {
    marginTop: '12px',
    padding: '10px 14px',
    borderRadius: '8px',
    fontSize: '13px',
    lineHeight: 1.6,
    background: ok ? 'var(--td-success-color-light, #e8f8f0)' : 'var(--td-error-color-light, #fdecee)',
    color: ok ? 'var(--td-success-color, #2ba471)' : 'var(--td-error-color, #d54941)',
    border: `1px solid ${ok ? 'var(--td-success-color-3, #b3e5cd)' : 'var(--td-error-color-3, #f5c1c5)'}`,
  };
}

export function SetupWizard({ onDone }: { onDone: (cfg: LlmConfig) => void }) {
  const [protocol, setProtocol] = useState<LlmProtocol>('openai');
  const [presetId, setPresetId] = useState('deepseek');
  const [baseUrl, setBaseUrl] = useState(PRESETS[0].baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(PRESETS[0].models[0]);
  const [models, setModels] = useState<string[]>(PRESETS[0].models);
  const [modelsLive, setModelsLive] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  /** 切协议时用它暂存 OpenAI 侧的模型名，免得来回切就把用户填的弄丢 */
  const openaiModelRef = useRef(PRESETS[0].models[0]);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [hostLogin, setHostLogin] = useState(false);
  const [identity, setIdentity] = useState('');

  useEffect(() => {
    // 先把身份码落下来（本机首次打开会顺便认领历史数据）
    ensureIdentity()
      .then((t) => setIdentity(t.slice(0, 8)))
      .catch(() => setIdentity(''));
    apiGet<{ isLoggedIn: boolean }>('/api/check-login')
      .then((j) => setHostLogin(Boolean(j?.isLoggedIn)))
      .catch(() => setHostLogin(false));
  }, []);

  const cfg: LlmConfig = useMemo(
    () => ({ protocol, baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim() }),
    [protocol, baseUrl, apiKey, model],
  );

  const complete = protocol === 'codebuddy' ? true : Boolean(cfg.baseUrl && cfg.apiKey && cfg.model);

  /**
   * Key 填完之后自动拉一次真实模型列表。
   *
   * 预设里的模型名随时会过时（DeepSeek 就从 deepseek-chat 换到了 deepseek-flash），
   * 照着过时的预设选、点「测试连接」失败，用户会以为是自己的问题。
   * 这里用你 key 下真实存在的模型覆盖 chips，让「看到的」和「能用的」一致。
   */
  const autoPulled = useRef('');
  useEffect(() => {
    if (protocol !== 'openai') return;
    const key = cfg.apiKey;
    if (!cfg.baseUrl || key.length < 8) return;
    const sig = `${cfg.baseUrl}|${key}`;
    if (autoPulled.current === sig) return;

    const timer = setTimeout(async () => {
      try {
        const list = await fetchLlmModels(cfg);
        if (!list.length) return;
        autoPulled.current = sig;
        setModels(list);
        setModelsLive(true);
        setModel((cur) => {
          if (!cur) return list[0];
          const presetModels = PRESETS.find((p) => p.id === presetId)?.models ?? [];
          // 只在「当前选的是预设里的名字、而真实列表里没有」时自动纠正。
          // 用户手填的名字（比如中转站的自定义名）不动它。
          if (!list.includes(cur) && presetModels.includes(cur)) return list[0];
          return cur;
        });
      } catch {
        /* 拉不到就继续用预设示例，不打扰用户 */
      }
    }, 900);

    return () => clearTimeout(timer);
    // cfg 每次渲染都是新对象，只依赖真正影响请求的三个字段
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [protocol, cfg.baseUrl, cfg.apiKey, presetId]);

  function pickPreset(p: Preset) {
    setPresetId(p.id);
    setBaseUrl(p.baseUrl);
    setModels(p.models);
    setModelsLive(false);
    setModel(p.models[0] || '');
    setResult(null);
  }

  /**
   * 切换接入方式时，**不能把另一个协议的模型名带过去**。
   *
   * 踩过的坑：先用 DeepSeek 预设填了 `deepseek-flash`，再点「本机 CodeBuddy 登录」，
   * 模型框里还是 `deepseek-flash` —— 而 SDK 的模型叫 `deepseek-v4.1-flash`。
   * 名字不对，SDK 直接报错，用户却以为是「登录坏了」。
   * 所以切换时：OpenAI 侧的名字存起来，CodeBuddy 侧一律留空（留空=用默认）。
   */
  function switchProtocol(next: LlmProtocol) {
    if (next === protocol) return;
    if (protocol === 'openai') openaiModelRef.current = model;
    setProtocol(next);
    setModel(next === 'openai' ? openaiModelRef.current : '');
    setResult(null);
  }

  async function doTest() {
    setTesting(true);
    setResult(null);
    try {
      const r = await testLlm(cfg);
      setResult(r);
      if (r.ok) {
        try {
          const list = await fetchLlmModels(cfg);
          if (list.length) setModels(list);
        } catch {
          /* 列表拉不到不影响使用 */
        }
      }
    } catch (e: any) {
      setResult({ ok: false, message: e?.message || '测试失败' });
    } finally {
      setTesting(false);
    }
  }

  async function doLoadModels() {
    setLoadingModels(true);
    try {
      const list = await fetchLlmModels(cfg);
      if (list.length) {
        setModels(list);
        setModelsLive(true);
        autoPulled.current = `${cfg.baseUrl}|${cfg.apiKey}`; // 手动拉过了，自动拉不必再跑一遍
      }
      if (list.length && !list.includes(model)) setModel(list[0]);
      setResult(list.length ? { ok: true, message: `拉到 ${list.length} 个模型` } : { ok: false, message: '这个 key 下没有可用模型' });
    } catch (e: any) {
      setResult({ ok: false, message: e?.message || '拉取失败' });
    } finally {
      setLoadingModels(false);
    }
  }

  const canStart = complete && result?.ok === true;

  return (
    <div style={S.overlay}>
      <div style={S.card}>
        <div style={S.title}>
          <span
            style={{
              width: 30,
              height: 30,
              borderRadius: 9,
              background: 'var(--td-brand-color)',
              color: 'var(--td-text-color-anti)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 15,
              fontWeight: 600,
            }}
          >
            {APP_CONFIG.nameInitial}
          </span>
          {APP_CONFIG.name}
        </div>
        <div style={S.sub}>
          开始之前，请先接入<strong>你自己的大模型 API</strong>。
          <br />
          配好并通过测试之后才能开始写作 —— 这个应用不内置任何共享额度。
        </div>

        {/* 接入方式 */}
        <div style={S.sectionLabel}>接入方式</div>
        <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
          <div style={S.protocol(protocol === 'openai')} onClick={() => switchProtocol('openai')}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>OpenAI 兼容接口（推荐）</div>
            <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)', lineHeight: 1.6 }}>
              DeepSeek / Kimi / 智谱 / 通义 / OpenAI 或任意中转，填 Base URL + Key 即可
            </div>
          </div>
          {hostLogin && (
            <div style={S.protocol(protocol === 'codebuddy')} onClick={() => switchProtocol('codebuddy')}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>本机 CodeBuddy 登录</div>
              <div style={{ fontSize: 12, color: 'var(--td-text-color-secondary)', lineHeight: 1.6 }}>
                复用这台机器上已登录的 CodeBuddy，无需填 Key（仅本机可用）
              </div>
            </div>
          )}
        </div>

        {protocol === 'openai' && (
          <>
            <div style={S.sectionLabel}>快捷预设</div>
            <div style={S.presetWrap}>
              {PRESETS.map((p) => (
                <div key={p.id} style={S.preset(presetId === p.id)} onClick={() => pickPreset(p)} title={p.hint}>
                  {p.label}
                </div>
              ))}
            </div>

            <div style={S.row}>
              <label style={S.label}>Base URL</label>
              <input
                style={S.input}
                value={baseUrl}
                onChange={(e) => { setBaseUrl(e.target.value); setResult(null); setPresetId('custom'); }}
                placeholder="https://api.deepseek.com/v1"
                spellCheck={false}
              />
              <div style={S.tip}>填到 <code>/v1</code> 为止即可，会自动补 <code>/chat/completions</code></div>
            </div>

            <div style={S.row}>
              <label style={S.label}>API Key</label>
              <input
                style={S.input}
                type="password"
                value={apiKey}
                onChange={(e) => { setApiKey(e.target.value); setResult(null); }}
                placeholder="sk-..."
                spellCheck={false}
                autoComplete="off"
              />
              <div style={S.tip}>只存在你这台设备的浏览器里，不会上传到服务器</div>
            </div>

            <div style={S.row}>
              <label style={S.label}>模型</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  style={{ ...S.input, flex: 1 }}
                  value={model}
                  onChange={(e) => { setModel(e.target.value); setResult(null); }}
                  placeholder="deepseek-flash"
                  spellCheck={false}
                  list="llm-model-options"
                />
                <datalist id="llm-model-options">
                  {models.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                <button
                  style={S.btn(false, loadingModels || !cfg.baseUrl || !cfg.apiKey)}
                  disabled={loadingModels || !cfg.baseUrl || !cfg.apiKey}
                  onClick={doLoadModels}
                >
                  {loadingModels ? '拉取中…' : '拉取列表'}
                </button>
              </div>
              {models.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                  {models.slice(0, 8).map((m) => (
                    <div key={m} style={S.preset(model === m)} onClick={() => { setModel(m); setResult(null); }}>
                      {m}
                    </div>
                  ))}
                </div>
              )}
              <div style={S.tip}>
                {modelsLive ? (
                  <>
                    以上 {models.length} 个是<strong>你的 key 下真实可用的模型</strong>（已从接口拉取）。
                  </>
                ) : (
                  <>
                    以上只是常见示例，不一定是这个 key 下的真实清单。填好 Key 会自动拉取，
                    也可点「拉取列表」；模型名支持直接手填，中转站的自定义名也认。
                  </>
                )}
              </div>
            </div>
          </>
        )}

        {protocol === 'codebuddy' && (
          <div style={S.row}>
            <label style={S.label}>模型（留空用默认）</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                style={{ ...S.input, flex: 1 }}
                value={model}
                onChange={(e) => { setModel(e.target.value); setResult(null); }}
                placeholder="留空即可，例如 deepseek-v4.1-flash"
                spellCheck={false}
              />
              <button
                style={S.btn(false, loadingModels)}
                disabled={loadingModels}
                onClick={doLoadModels}
              >
                {loadingModels ? '拉取中…' : '拉取列表'}
              </button>
            </div>
            {models.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                {models.slice(0, 10).map((m) => (
                  <div key={m} style={S.preset(model === m)} onClick={() => { setModel(m); setResult(null); }}>
                    {m}
                  </div>
                ))}
              </div>
            )}
            <div style={S.tip}>
              只认 SDK 自己的模型名（如 <code>deepseek-v4.1-flash</code>、<code>hy3</code>），
              别填 <code>deepseek-flash</code> 这类第三方名字 —— 名字不对模型会返回一堆没法解析的东西。
              点「拉取列表」按你的登录态查真实可用的模型。
            </div>
            <div style={{ ...S.tip, marginTop: 6 }}>
              ⚠️ 这种方式要拉起 CodeBuddy 命令行进程，会占用 <code>127.0.0.1:56713</code>。
              如果 <strong>WorkBuddy / CodeBuddy 正开着</strong>，端口被它占着，这里会时好时坏 ——
              此时请改用上面的「OpenAI 兼容接口」。
            </div>
          </div>
        )}

        {/* 测试 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 22 }}>
          <button style={S.btn(false, testing || !complete)} disabled={testing || !complete} onClick={doTest}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          {result && <div style={{ ...resultBox(result.ok), marginTop: 0, flex: 1 }}>{result.message}</div>}
        </div>

        <div style={S.privacy}>
          <div style={{ fontWeight: 600, color: 'var(--td-text-color-primary)', marginBottom: 6 }}>
            关于隐私，你可以放心的三件事
          </div>
          1. <strong>API Key 只存在你的浏览器</strong>。每次请求临时带给服务端转发给模型接口，用完即弃，
          不写数据库、不写日志、不落盘。关掉浏览器就没了。
          <br />
          2. <strong>你和别人的数据完全隔离</strong>。你的小说、设定、聊天记录都存在服务端一个只属于你的
          目录里，入口是你浏览器生成的一串随机身份码 —— 服务端只存它的哈希，无法反推、无法冒充。
          <br />
          3. <strong>模型调用不经我们的账号</strong>。消耗的是你自己的额度，我们看不到你的对话内容
          （只在你自己的浏览器和模型服务商之间流转）。
          {identity && (
            <>
              <br />
              <span style={{ opacity: 0.7 }}>
                你的身份码：<code>{identity}…</code>（清空浏览器数据会丢失，作品请及时用「导出」保存）
              </span>
            </>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 24 }}>
          <button
            style={S.btn(true, !canStart)}
            disabled={!canStart}
            onClick={() => canStart && onDone(cfg)}
          >
            {canStart ? '开始使用' : '请先通过连接测试'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default SetupWizard;
