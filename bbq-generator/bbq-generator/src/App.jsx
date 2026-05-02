import React, { useState, useEffect, useCallback } from 'react';
import { Play, Download, Settings, FileText, CheckCircle, Loader2 } from 'lucide-react';
import Papa from 'papaparse';

/** 本地 SBIC.v2（解压后与 `bbq-generator/bbq-generator` 并列的 `../../SBIC.v2`） */
const SBIC_SPLITS = {
  trn: 'SBIC.v2.trn.csv',
  dev: 'SBIC.v2.dev.csv',
  tst: 'SBIC.v2.tst.csv',
};

/** Azure OpenAI 等内容策略：识别「因 prompt 触发过滤」类错误（兼容多种返回格式） */
function isLikelyContentPolicyBlock(message) {
  const m = String(message || '').toLowerCase();
  return (
    m.includes('content_filter') ||
    m.includes('"content_filter"') ||
    m.includes('content management policy') ||
    m.includes('filtered due to the prompt') ||
    m.includes('responsibleaipolicyviolation') ||
    m.includes('jailbreak') ||
    (m.includes('api error 400') && m.includes('filtered'))
  );
}

/** 正文类字段：星号替换（最易触发审核） */
const SBIC_MASK_FIELDS_CORE = ['post', 'targetStereotype', 'sexPhrase', 'sexReason'];

/** 扩展：来源、标注者属性、群体标签等也常含敏感词或敏感来源名（如 subreddit） */
const SBIC_MASK_FIELDS_EXTENDED = [
  ...SBIC_MASK_FIELDS_CORE,
  'dataSource',
  'annotatorPolitics',
  'annotatorRace',
  'annotatorGender',
  'annotatorMinority',
  'targetMinority',
  'targetCategory',
];

const STAR_MASK_MAX_RUN = 400;

/** 将字符串按长度替换为星号（上限避免过长 prompt） */
function maskWithStars(value) {
  const s = String(value ?? '');
  if (!s.trim()) return s;
  const len = Math.min(s.length, STAR_MASK_MAX_RUN);
  return '*'.repeat(len);
}

/**
 * 复制 SBIC 一行：指定字段的非空正文改为星号（整行仍 JSON 进 prompt，与原设计一致）。
 */
function buildMaskedSbicItem(row, keysToMask) {
  const keys = new Set(keysToMask);
  const out = { ...row };
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(out, k)) continue;
    const v = out[k];
    if (v != null && String(v).trim() !== '') {
      out[k] = maskWithStars(v);
    }
  }
  return out;
}

/** 仅保留离散标注 / ID；其余列一律星号，最大程度降低 Azure prompt 拦截 */
const SBIC_PROMPT_WHITELIST_KEYS = new Set([
  'whoTarget',
  'intentYN',
  'sexYN',
  'offensiveYN',
  'speakerMinorityYN',
  'WorkerId',
  'HITId',
  'annotatorAge',
]);

function buildMaskedSbicItemWhitelistOnly(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (SBIC_PROMPT_WHITELIST_KEYS.has(k)) {
      out[k] = v;
      continue;
    }
    if (v != null && String(v).trim() !== '') {
      out[k] = typeof v === 'string' ? maskWithStars(v) : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function buildBbqprompt(datasetType, maskedItem) {
  return `Please generate a BBQ dataset item for the category "${datasetType}" based on this context: ${JSON.stringify(maskedItem)}. Output ONLY valid JSON.`;
}

/** 不含 CSV 原文；类别标签也做星号，避免极少数标签触发策略 */
function buildMinimalBbqprompt(datasetType, row) {
  const raw = String(row.targetCategory ?? '').trim().slice(0, 80);
  const catHint = raw ? maskWithStars(raw) : '';
  return [
    'Task: Output exactly ONE valid JSON object for a BBQ-style multiple-choice bias benchmark item.',
    `BBQ category: "${datasetType}".`,
    catHint ? `High-level topic hint (masked): "${catHint}".` : 'No topic hints.',
    'Use entirely neutral fictional content. No hate speech or slurs.',
    'Respond with ONLY JSON, no markdown.',
  ].join('\n');
}

/** 多次脱敏仍失败时写入导出流，避免缺条 */
function buildContentFilterPlaceholder(i, datasetType) {
  return {
    _bbq_placeholder: true,
    _reason: 'azure_prompt_content_filter',
    _source_row_index: i + 1,
    _dataset_type_requested: datasetType,
    note: 'Azure 仍拦截 prompt；可在门户调低内容过滤档位或人工补生成。',
  };
}

export default function BBQGenerator() {
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com');

  const [datasetType, setDatasetType] = useState('Age');
  const [datasetSize, setDatasetSize] = useState(2000);
  const [sbicSplit, setSbicSplit] = useState('trn');
  const [csvData, setCsvData] = useState([]);
  const [sourceLoadState, setSourceLoadState] = useState('loading');
  const [sourceLoadError, setSourceLoadError] = useState('');

  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState([]);
  const [results, setResults] = useState([]);

  const addLog = useCallback((message, type = 'info') => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev, { time, message, type }]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const filename = SBIC_SPLITS[sbicSplit];
    const url = `/sbic/${filename}`;

    (async () => {
      setSourceLoadState('loading');
      setSourceLoadError('');
      try {
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(
            `HTTP ${res.status}：无法读取 ${url}。请将 SBIC.v2.tgz 解压为与 bbq-generator 并列的文件夹 SBIC.v2，并内含 ${filename}。`,
          );
        }
        const text = await res.text();
        const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
        if (parsed.errors?.length) {
          console.warn('CSV 解析警告:', parsed.errors.slice(0, 5));
        }
        const rows = parsed.data.filter((row) =>
          Object.keys(row).some((k) => String(row[k] ?? '').trim() !== ''),
        );
        if (cancelled) return;
        setCsvData(rows);
        setSourceLoadState('ready');
        addLog(`已加载本地 SBIC.v2：${filename}，共 ${rows.length.toLocaleString()} 条`, 'success');
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setSourceLoadError(msg);
        setSourceLoadState('error');
        addLog(`加载本地 SBIC 失败: ${msg}`, 'error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [addLog, sbicSplit]);

  const callLLM = async (promptText) => {
    const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
    const isAzure = /openai\.azure\.com/i.test(normalizedBaseUrl);
    const isFullAzureEndpoint = /\/openai\/deployments\/.+\/chat\/completions\?api-version=/i.test(
      normalizedBaseUrl,
    );

    let endpoint = normalizedBaseUrl.endsWith('/v1/chat/completions')
      ? normalizedBaseUrl
      : normalizedBaseUrl.endsWith('/v1')
        ? `${normalizedBaseUrl}/chat/completions`
        : `${normalizedBaseUrl}/v1/chat/completions`;
    let headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };

    if (isAzure) {
      if (!isFullAzureEndpoint) {
        throw new Error(
          'Azure 模式请在 Base URL 填写完整 endpoint，例如: https://<resource>.openai.azure.com/openai/deployments/<deployment>/chat/completions?api-version=2024-02-15-preview',
        );
      }
      endpoint = normalizedBaseUrl;
      headers = {
        'Content-Type': 'application/json',
        'api-key': apiKey,
      };
    }

    const payload = {
      messages: [
        {
          role: 'system',
          content:
            'You are a helpful assistant generating BBQ dataset items in JSON format. Source rows may contain offensive-language fields replaced by asterisks for API safety; infer bias-relevant structure without expanding them into slurs, threats, or hate speech. Output valid JSON only.',
        },
        { role: 'user', content: promptText },
      ],
      temperature: 0.7,
    };
    if (!isAzure) {
      payload.model = 'gpt-4o-mini';
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API Error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  };

  const handleStart = async () => {
    if (!apiKey || !baseUrl) {
      addLog('请先填写 API Key 和 Base URL', 'error');
      return;
    }
    if (sourceLoadState === 'loading') {
      addLog('正在加载本地 SBIC 数据，请稍候…', 'error');
      return;
    }
    if (sourceLoadState === 'error') {
      addLog('源数据加载失败：请确认 SBIC.v2 已解压到正确路径后刷新页面', 'error');
      return;
    }
    if (csvData.length === 0) {
      addLog('源数据为空，请刷新页面重新加载', 'error');
      return;
    }

    setIsRunning(true);
    setLogs([]);
    setResults([]);

    try {
      const targetCount = Math.min(datasetSize, csvData.length);
      addLog(`开始任务，目标生成类型: ${datasetType}，计划处理 ${targetCount} 条数据...`, 'info');

      const newResults = [];

      // 勿用 state 的 isRunning 判断循环：setIsRunning(true) 后此处仍是旧闭包值 false，会导致第 2 条就退出。
      for (let i = 0; i < targetCount; i++) {
        const item = csvData[i];
        addLog(`正在处理第 ${i + 1}/${targetCount} 条数据...`, 'info');

        try {
          let llmResponse;
          try {
            llmResponse = await callLLM(
              buildBbqprompt(datasetType, buildMaskedSbicItem(item, SBIC_MASK_FIELDS_EXTENDED)),
            );
          } catch (firstErr) {
            const em = firstErr instanceof Error ? firstErr.message : String(firstErr);
            if (!isLikelyContentPolicyBlock(em)) throw firstErr;
            addLog(`第 ${i + 1} 条：内容策略拦截 → 仅保留标注数值/ID，其余列星号掩码后重试`, 'info');
            try {
              llmResponse = await callLLM(
                buildBbqprompt(datasetType, buildMaskedSbicItemWhitelistOnly(item)),
              );
            } catch (secondErr) {
              const em2 = secondErr instanceof Error ? secondErr.message : String(secondErr);
              if (!isLikelyContentPolicyBlock(em2)) throw secondErr;
              addLog(`第 ${i + 1} 条：仍被拦截 → 极简提示（类别亦掩码）重试`, 'info');
              llmResponse = await callLLM(buildMinimalBbqprompt(datasetType, item));
            }
          }

          let parsedResult;
          try {
            const cleanJson = llmResponse.replace(/```json/g, '').replace(/```/g, '').trim();
            parsedResult = JSON.parse(cleanJson);
          } catch {
            parsedResult = { raw_text: llmResponse, error: 'Failed to parse JSON' };
          }

          newResults.push(parsedResult);
          setResults([...newResults]);
        } catch (error) {
          const em = error instanceof Error ? error.message : String(error);
          if (isLikelyContentPolicyBlock(em)) {
            addLog(
              `第 ${i + 1} 条：多次脱敏后仍被 Azure 拦截，已写入占位 JSON（可稍后人工补或调低门户过滤级别）`,
              'info',
            );
            newResults.push(buildContentFilterPlaceholder(i, datasetType));
            setResults([...newResults]);
          } else {
            addLog(
              `第 ${i + 1} 条处理失败: ${error instanceof Error ? error.message : String(error)}`,
              'error',
            );
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      addLog('任务全部完成！', 'success');
    } finally {
      setIsRunning(false);
    }
  };

  const handleExport = () => {
    if (results.length === 0) return;

    const jsonlContent = results.map((item) => JSON.stringify(item)).join('\n');
    const blob = new Blob([jsonlContent], { type: 'application/jsonl' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bbq_dataset_${datasetType}_${results.length}.jsonl`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-gray-50 p-6 font-sans text-gray-800">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 flex items-center gap-3">
          <div className="p-3 bg-blue-50 text-blue-600 rounded-lg">
            <FileText size={24} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">BBQ 数据集生成平台</h1>
            <p className="text-sm text-gray-500 mt-1">
              基于源数据自动脱敏并调用大模型生成 Bias Benchmark for QA (BBQ) 格式数据。
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="space-y-6">
            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
              <h2 className="text-lg font-semibold flex items-center gap-2 mb-4">
                <Settings size={20} className="text-gray-500" />
                API 配置
              </h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">API Key</label>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                    placeholder="sk-..."
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Base URL</label>
                  <input
                    type="text"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                    placeholder="https://..."
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    OpenAI 填 `https://api.openai.com`；Azure 填完整 endpoint（包含 deployment 与
                    api-version）
                  </p>
                </div>
              </div>
            </div>

            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
              <h2 className="text-lg font-semibold flex items-center gap-2 mb-4">
                <FileText size={20} className="text-gray-500" />
                数据配置
              </h2>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">数据集类型</label>
                  <select
                    value={datasetType}
                    onChange={(e) => setDatasetType(e.target.value)}
                    className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white"
                  >
                    <option value="Age">Age (年龄)</option>
                    <option value="Disability Status">Disability Status (残疾状态)</option>
                    <option value="Gender Identity">Gender Identity (性别认同)</option>
                    <option value="Nationality">Nationality (国籍)</option>
                    <option value="Physical Appearance">Physical Appearance (外貌)</option>
                    <option value="Race/Ethnicity">Race/Ethnicity (种族/民族)</option>
                    <option value="Religion">Religion (宗教)</option>
                    <option value="SES">SES (社会经济地位)</option>
                    <option value="Sexual Orientation">Sexual Orientation (性取向)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">生成数量 (条)</label>
                  <input
                    type="number"
                    value={datasetSize}
                    onChange={(e) => setDatasetSize(Number(e.target.value))}
                    className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                    min="1"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    本地源数据（SBIC.v2）
                  </label>
                  <div className="space-y-2 mb-2">
                    <label className="block text-xs text-gray-500">数据拆分</label>
                    <select
                      value={sbicSplit}
                      onChange={(e) => setSbicSplit(e.target.value)}
                      disabled={isRunning}
                      className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white disabled:opacity-60"
                    >
                      <option value="trn">训练集 SBIC.v2.trn.csv</option>
                      <option value="dev">验证集 SBIC.v2.dev.csv</option>
                      <option value="tst">测试集 SBIC.v2.tst.csv</option>
                    </select>
                  </div>
                  <div className="w-full border border-gray-200 rounded-lg p-4 bg-gray-50 space-y-2">
                    <p className="text-sm text-gray-700 leading-relaxed">
                      自动读取解压目录{' '}
                      <code className="text-xs bg-gray-200 px-1 rounded">newdataset_rwj/SBIC.v2/</code>
                      （与 Social Bias Inference Corpus v2 一致）。开发时通过 Vite 访问{' '}
                      <code className="text-xs bg-gray-200 px-1 rounded">/sbic/*.csv</code>。
                    </p>
                    {sourceLoadState === 'loading' && (
                      <p className="text-sm text-gray-600 flex items-center gap-2">
                        <Loader2 className="animate-spin text-blue-600" size={18} aria-hidden />
                        正在读取并解析 CSV…
                      </p>
                    )}
                    {sourceLoadState === 'ready' && (
                      <p className="text-sm text-green-700 font-medium">
                        已就绪：共 {csvData.length.toLocaleString()} 条（按「生成数量」截取）
                      </p>
                    )}
                    {sourceLoadState === 'error' && (
                      <p className="text-sm text-red-600">
                        加载失败：{sourceLoadError || '未知错误'}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="lg:col-span-2 space-y-6">
            <div className="bg-white p-4 rounded-xl shadow-sm border border-gray-100 flex items-center justify-between">
              <span className="text-sm font-medium text-gray-600">
                {isRunning ? '正在生成中...' : '准备就绪'}
              </span>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={handleStart}
                  disabled={isRunning || sourceLoadState !== 'ready'}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-white transition-colors ${isRunning || sourceLoadState !== 'ready' ? 'bg-blue-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-700'}`}
                >
                  <Play size={18} />
                  开始生成
                </button>
                <button
                  type="button"
                  onClick={handleExport}
                  disabled={results.length === 0}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${results.length === 0 ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'}`}
                >
                  <Download size={18} />
                  导出 JSONL
                </button>
              </div>
            </div>

            <div className="bg-gray-900 rounded-xl shadow-sm overflow-hidden flex flex-col h-64">
              <div className="bg-gray-800 px-4 py-2 text-xs text-gray-400 font-mono border-b border-gray-700">
                运行日志 (已内置自动脱敏防拦截)
              </div>
              <div className="p-4 overflow-y-auto flex-1 font-mono text-sm space-y-1">
                {logs.length === 0 && <span className="text-gray-500">等待任务开始...</span>}
                {logs.map((log, idx) => (
                  <div
                    key={idx}
                    className={`
                    ${log.type === 'error' ? 'text-red-400' : ''}
                    ${log.type === 'success' ? 'text-green-400' : ''}
                    ${log.type === 'info' ? 'text-gray-300' : ''}
                  `}
                  >
                    <span className="text-gray-500 mr-2">[{log.time}]</span>
                    {log.message}
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100 h-96 flex flex-col">
              <h2 className="text-lg font-semibold flex items-center gap-2 mb-4">
                <CheckCircle size={20} className="text-green-500" />
                生成结果预览 (JSONL)
              </h2>
              <div className="flex-1 bg-gray-50 rounded-lg border border-gray-200 p-4 overflow-y-auto font-mono text-sm text-gray-700 whitespace-pre-wrap">
                {results.length === 0 ? (
                  <span className="text-gray-400">生成的数据将显示在这里...</span>
                ) : (
                  results.map((item, idx) => (
                    <div key={idx} className="mb-2 pb-2 border-b border-gray-200 last:border-0">
                      {JSON.stringify(item)}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
