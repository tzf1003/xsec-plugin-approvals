// XSEC Frontend API v2 — single-file ESM.  All data comes through the
// manifest-declared broker methods; the iframe has no direct Tauri access.
const DECISIONS = { allowed: ["允许", "success"], denied: ["拒绝", "danger"], manual_review: ["人工审批", "warning"], bypass: ["绕过", "volcano"], error: ["错误", "magenta"] };
const FILTER_DECISIONS = ["allowed", "denied", "manual_review", "bypass", "error"];
const RISKS = { low: "低", medium: "中", high: "高", critical: "严重" };
const MODES = { manual: "人工", auto_llm: "LLM", full_access: "完全访问" };
const WINDOWS = [["all", "全部"], ["24h", "24 小时"], ["7d", "7 天"], ["30d", "30 天"]];
const WINDOW_MS = { "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 };
const MIN_CONFIDENCE = 0;
const MAX_CONFIDENCE = 1;
const MIN_TIMEOUT_MS = 1_000;
const AUTO_REFRESH_INTERVAL_MS = 15_000;
const FILTER_DEBOUNCE_MS = 250;
const FULL_ACCESS_CONFIRMATION = "我确认启用完全访问权限";

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function isRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function text(value) { return value === undefined || value === null || value === "" ? "—" : String(value); }
function errorText(error) { return error instanceof Error ? error.message : String(error); }
function logFailure(event, error) { console.error(event, { message: errorText(error) }); }
function sessionIdFrom(context) {
  const id = context?.workspace?.session?.session_id || context?.workspace?.binding?.sessionId;
  return typeof id === "string" && id.trim() ? id : undefined;
}
function formatTime(value) {
  const stamp = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(stamp) ? new Date(stamp).toLocaleString("zh-CN") : "—";
}
function decisionInfo(row) {
  const value = row.final_decision || row.decision || "未知";
  return DECISIONS[value] || [value, "neutral"];
}
function applyTheme(theme) {
  const mode = theme?.["color-mode"] || getComputedStyle(document.documentElement).getPropertyValue("--xsec-color-mode").trim();
  document.documentElement.dataset.xsecTheme = mode === "light" ? "light" : "dark";
}
function isNumericSetting(value) { return typeof value === "number" && Number.isFinite(value); }
function validSettings(settings) {
  const threshold = Number(settings?.low_confidence_threshold); const timeout = Number(settings?.llm?.timeout_ms);
  return isRecord(settings) && isRecord(settings.llm)
    && typeof settings.auto_enabled === "boolean" && typeof settings.full_access === "boolean" && typeof settings.allow_local_readonly === "boolean"
    && typeof settings.llm.use_default_model === "boolean" && (settings.llm.use_default_model || typeof settings.llm.model === "string")
    && isNumericSetting(settings.low_confidence_threshold) && threshold >= MIN_CONFIDENCE && threshold <= MAX_CONFIDENCE
    && isNumericSetting(settings.llm.timeout_ms) && Number.isSafeInteger(timeout) && timeout >= MIN_TIMEOUT_MS;
}
function applySettings(controls, settings) {
  if (!validSettings(settings)) throw new Error("审批设置响应无效");
  controls.auto.checked = settings.auto_enabled; controls.full.checked = settings.full_access; controls.risk.hidden = !settings.full_access;
  controls.acknowledge.checked = false; controls.confirm.value = ""; controls.readonly.checked = settings.allow_local_readonly;
  controls.threshold.value = String(settings.low_confidence_threshold); controls.model.value = settings.llm.use_default_model ? "" : settings.llm.model;
  controls.timeout.value = String(settings.llm.timeout_ms);
}
function showResolvedModel(controls, settings) {
  const value = settings?.resolved_model;
  controls.modelStatus.textContent = value?.error ? `模型状态：${value.error}` : value?.model
    ? `模型状态：${value.provider || "默认服务商"} / ${value.model}（${value.api_key_available ? "凭据可用" : "凭据不可用"}）`
    : `模型状态：${settings?.api_key_configured ? "使用当前会话模型" : "尚未配置固定审批模型"}`;
}
function showSettingsOverview(controls, settings) {
  const model = settings?.llm?.use_default_model ? "跟随当前会话模型" : (settings?.llm?.model || "未配置");
  const values = [["新会话默认模式", settings?.auto_enabled ? "LLM 自动审批" : "人工审批"], ["完全访问授权", settings?.full_access ? "已授权，可显式选择" : "未授权"], ["审批模型策略", model]];
  controls.summary.replaceChildren(); for (const [label, value] of values) controls.summary.append(detailValue(label, value));
}
function settingsContextKey(context) {
  const settings = isRecord(context?.settings) ? context.settings : {};
  return JSON.stringify([context?.kind, settings.id, settings.page]);
}

function addStyles(root) {
  const style = element("style");
  style.textContent = `:root{font:13px/1.45 var(--xsec-font-family,system-ui,sans-serif)}.xsec-approvals,.approval-settings{--bg:#0f141b;--surface:#111924;--control:#18212d;--line:#303b4c;--strong:#d7dee8;--muted:#9aa7b7;--hover:#202d3c;--error:#ff8e8e;min-height:100%;color:var(--strong);background:var(--bg)}:root[data-xsec-theme=light] .xsec-approvals,:root[data-xsec-theme=light] .approval-settings{--bg:#f7f9fc;--surface:#fff;--control:#fff;--line:#d7dee8;--strong:#18212d;--muted:#66758a;--hover:#edf3fb;--error:#bd3030}.xsec-approvals *,.approval-settings *{box-sizing:border-box}.xsec-approvals{padding:12px}.approval-card{border:1px solid var(--line);border-radius:8px;background:var(--surface);padding:10px;margin-bottom:12px}.approval-summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.approval-stat{min-width:0;padding:8px;border:1px solid var(--line);border-radius:7px}.approval-label,.approval-meta,.approval-status{color:var(--muted);font-size:12px}.approval-value{overflow:hidden;margin-top:2px;font-size:18px;font-weight:650;text-overflow:ellipsis;white-space:nowrap}.approval-card-head,.approval-row-title,.approval-toolbar{display:flex;align-items:center;gap:8px}.approval-card-head{justify-content:space-between;margin-bottom:10px}.approval-card-title{margin:0;font-size:14px}.approval-toolbar{flex-wrap:wrap;margin-bottom:9px}.approval-button,.approval-select,.approval-input{border:1px solid var(--line);border-radius:6px;padding:5px 8px;color:var(--strong);background:var(--control);font:inherit}.approval-button{cursor:pointer}.approval-button:disabled{cursor:wait;opacity:.65}.approval-window[aria-pressed=true]{border-color:#4f7cff;color:#fff;background:#25457a}.approval-status{min-height:20px;margin:0 0 8px}.approval-status[data-tone=error]{color:var(--error)}.approval-list{display:grid;gap:7px}.approval-row{width:100%;padding:9px;border:1px solid var(--line);border-radius:7px;color:var(--strong);background:var(--surface);font:inherit;text-align:left;cursor:pointer}.approval-row:hover{background:var(--hover)}.approval-row-title{justify-content:space-between}.approval-preview{display:block;overflow:hidden;margin:4px 0;color:var(--muted);text-overflow:ellipsis;white-space:nowrap}.approval-badge{flex:none;border-radius:999px;padding:1px 6px;font-size:11px}.success{color:#82e6a8;background:#163a29}.warning{color:#ffd17a;background:#453318}.danger{color:#ff9999;background:#4a2027}.volcano{color:#ffb17a;background:#4a2d20}.magenta{color:#ff9cd5;background:#48213d}.neutral{color:var(--muted);background:var(--hover)}.approval-empty{padding:22px 10px;border:1px dashed var(--line);border-radius:7px;color:var(--muted);text-align:center}.approval-drawer{position:fixed;z-index:10;inset:0;display:grid;justify-items:end;background:#0007}.approval-drawer[hidden]{display:none}.approval-drawer-panel{width:min(560px,100%);height:100%;overflow:auto;padding:14px;background:var(--bg);box-shadow:-8px 0 26px #0004}.approval-drawer-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.approval-details{display:grid;gap:0;margin:12px 0}.approval-details div{padding:8px;border:1px solid var(--line);border-bottom:0}.approval-details div:last-child{border-bottom:1px solid var(--line)}.approval-details dt{margin-bottom:4px;color:var(--muted)}.approval-details dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.approval-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.approval-settings{max-width:760px;min-height:100vh;padding:18px}.approval-settings h1{margin:0;font-size:20px}.approval-settings p{color:var(--muted)}.approval-settings label{display:grid;gap:6px;margin:14px 0}.approval-settings .check{display:flex;align-items:center;gap:8px}.approval-model-status{padding:8px;border-left:3px solid #4f7cff;background:var(--surface)}@media(max-width:300px){.approval-summary{grid-template-columns:repeat(2,minmax(0,1fr))}}`;
  root.append(style);
}

function detailValue(label, value, code = false) {
  const item = element("div"); const title = element("dt", "", label); const body = element("dd", code ? "approval-code" : "", text(value));
  item.append(title, body); return item;
}
function policyValue(value) {
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.join("、") : value; } catch { return value; }
}
function detailContent(row) {
  const [label, tone] = decisionInfo(row);
  const items = [["请求 ID", row.request_id, true], ["工具", row.tool_name], ["最终决策", label], ["自动审批决定", row.gateway_decision ? (DECISIONS[row.gateway_decision]?.[0] || row.gateway_decision) : undefined], ["决定来源", row.resolution_source], ["风险等级", row.risk_level ? (RISKS[row.risk_level] || row.risk_level) : undefined], ["审批模式", MODES[row.mode] || row.mode], ["命令", row.command_preview, true], ["工作目录", row.cwd, true], ["参数", row.arguments_preview, true], ["自动审批原因", row.gateway_reason || row.reason], ["自动审批指引", row.gateway_guidance || row.agent_guidance], ["人工最终原因", row.final_reason], ["模型失败码", row.llm_failure_code], ["命中策略", row.policy_codes_json ? policyValue(row.policy_codes_json) : undefined], ["审批模型", row.model_name], ["置信度", row.model_confidence == null ? undefined : `${(Number(row.model_confidence) * 100).toFixed(1)}%`], ["耗时", row.model_latency_ms == null ? undefined : `${row.model_latency_ms} ms`], ["执行状态", row.execution_status], ["执行错误", row.execution_error], ["审批时间", row.approval_started_at == null ? undefined : formatTime(row.approval_started_at)]];
  return { label, tone, items: items.filter(([, value]) => value !== undefined && value !== null && value !== "") };
}
function renderDetail(row) {
  const { label, tone, items } = detailContent(row); const details = element("dl", "approval-details");
  for (const [title, value, code] of items) if (value !== undefined && value !== null && value !== "") details.append(detailValue(title, value, code));
  const decision = element("span", `approval-badge ${tone}`, label); return { decision, details };
}
function detailFingerprint(row) {
  const { label, tone, items } = detailContent(row);
  return JSON.stringify([label, tone, ...items.map(([title, value, code]) => [title, text(value), Boolean(code)])]);
}

export function activate(host) {
  function settingsPage() {
    let root; let controls; let settingsReady = false; let themeSubscription; let loadRevision = 0; let contextKey = settingsContextKey(host.context); let activeSave; let disposed = false; let lifecycleRevision = 0;
    const notice = (message, failed = false) => { controls.notice.textContent = message; controls.notice.dataset.tone = failed ? "error" : ""; };
    async function readSettings() {
      try { return await host.request("xsec.approvals.settings.get", {}); }
      catch (error) { logFailure("approvals.settings.load.failed", error); throw error; }
    }
    async function writeSettings(input) {
      try { return await host.request("xsec.approvals.settings.set", input); }
      catch (error) { logFailure("approvals.settings.save.failed", error); throw error; }
    }
    async function load() {
      if (activeSave) { activeSave.reloadQueued = true; controls.retry.disabled = true; return; }
      const revision = ++loadRevision;
      settingsReady = false; controls.save.disabled = true; controls.retry.disabled = true; notice("正在读取审批设置…");
      console.info("approvals.settings.load.started");
      try {
        const settings = await readSettings();
        if (revision !== loadRevision) return;
        applySettings(controls, settings);
        showResolvedModel(controls, settings); showSettingsOverview(controls, settings); settingsReady = true; controls.save.disabled = false; notice("");
        console.info("approvals.settings.load.completed", { fullAccessEnabled: settings.full_access, usesDefaultModel: settings.llm.use_default_model });
      } catch (error) { if (revision === loadRevision) notice(`读取审批设置失败：${errorText(error)}`, true); } finally { if (revision === loadRevision) controls.retry.disabled = false; }
    }
    async function save() {
      if (!settingsReady) return notice("请先成功读取当前审批设置后再保存。", true);
      const fullAccess = controls.full.checked; const acknowledged = fullAccess && controls.confirm.value === FULL_ACCESS_CONFIRMATION;
      const thresholdText = controls.threshold.value.trim(); const threshold = Number(thresholdText);
      const timeoutText = controls.timeout.value.trim(); const timeoutMs = Number(timeoutText);
      if (!thresholdText || !Number.isFinite(threshold) || threshold < MIN_CONFIDENCE || threshold > MAX_CONFIDENCE) return notice("低置信度阈值必须是 0 到 1 之间的数字。", true);
      if (!timeoutText || !Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS) return notice("模型超时必须是不小于 1000 毫秒的安全整数。", true);
      if (fullAccess && (!acknowledged || !controls.acknowledge.checked)) return notice("启用完全访问前，请确认风险声明并输入确认语句。", true);
      controls.save.disabled = true; controls.retry.disabled = true;
      const saveState = { lifecycle: lifecycleRevision, reloadQueued: false, revision: ++loadRevision }; activeSave = saveState; console.info("approvals.settings.save.started", { fullAccessEnabled: fullAccess });
      try {
        const settings = await writeSettings({ autoEnabled: controls.auto.checked, fullAccess, allowLocalReadonly: controls.readonly.checked, lowConfidenceThreshold: threshold, llm: { model: controls.model.value.trim(), timeoutMs, temperature: 0 }, fullAccessAcknowledged: acknowledged });
        if (activeSave !== saveState || saveState.revision !== loadRevision || disposed || saveState.lifecycle !== lifecycleRevision) return;
        applySettings(controls, settings); showResolvedModel(controls, settings); showSettingsOverview(controls, settings); settingsReady = true;
        const saved = "已保存。审批授权和只读放行立即生效；新会话默认策略仅影响之后创建的会话。";
        notice(saved); console.info("approvals.settings.save.completed", { fullAccessEnabled: settings.full_access, usesDefaultModel: settings.llm.use_default_model });
      } catch (error) { if (activeSave === saveState && saveState.revision === loadRevision && !disposed && saveState.lifecycle === lifecycleRevision) notice(`保存审批设置失败：${errorText(error)}`, true); } finally {
        if (activeSave !== saveState) return;
        activeSave = undefined;
        const shouldReload = saveState.reloadQueued && !disposed;
        if (shouldReload) void load();
        else if (!disposed && saveState.lifecycle === lifecycleRevision && saveState.revision === loadRevision) { controls.save.disabled = !settingsReady; controls.retry.disabled = false; }
      }
    }
    function field(title, input) { const label = element("label", "", title); label.append(input); return label; }
    function build() {
      root.replaceChildren(); addStyles(root); const page = element("main", "approval-settings");
      const auto = element("input"); auto.type = "checkbox"; const full = element("input"); full.type = "checkbox"; const readonly = element("input"); readonly.type = "checkbox"; const acknowledge = element("input"); acknowledge.type = "checkbox";
      const threshold = element("input", "approval-input"); threshold.type = "number"; threshold.min = "0"; threshold.max = "1"; threshold.step = "0.05";
      const model = element("input", "approval-input"); model.placeholder = "留空使用当前会话模型"; const timeout = element("input", "approval-input"); timeout.type = "number"; timeout.min = "1000"; timeout.step = "1000";
      const confirm = element("input", "approval-input"); confirm.placeholder = `启用完全访问时输入：${FULL_ACCESS_CONFIRMATION}`;
      const summaryCard = element("section", "approval-card"); const summary = element("dl", "approval-details"); summaryCard.append(element("h2", "approval-card-title", "审批策略"), summary);
      const saveButton = element("button", "approval-button", "保存设置"); const retryButton = element("button", "approval-button", "重新读取设置"); const status = element("p", "approval-model-status"); const note = element("p", "approval-status"); saveButton.disabled = true;
      const check = (input, label) => { const node = element("label", "check"); node.append(input, document.createTextNode(label)); return node; };
      const risk = element("section", "approval-card"); const riskTitle = element("strong", "", "完全访问确认"); const riskDetail = element("p", "", "启用后，普通会话、批量任务和资产发现可以显式选择完全访问。系统危险规则、工作区写入沙箱和审计仍然生效。请仅在目标与操作均已获得授权时继续。");
      risk.append(riskTitle, riskDetail, check(acknowledge, "我已了解上述风险，并确认当前操作仅用于合法且已获得授权的目标。"), field("请输入确认语句", confirm)); risk.hidden = true;
      const updateRisk = () => { risk.hidden = !full.checked; if (!full.checked) { acknowledge.checked = false; confirm.value = ""; } };
      saveButton.onclick = () => void save(); retryButton.onclick = () => void load();
      full.onchange = updateRisk;
      page.append(element("h1", "", "审批记录"), element("p", "", "新会话默认策略影响后续创建的普通会话；完全访问是全局可选上限，当前会话的模式仍在任务界面管理。"), summaryCard, check(auto, "新会话默认使用 LLM 自动审批"), check(full, "允许选择完全访问（高风险）"), risk, check(readonly, "本地只读调用直接放行"), field("低置信度阈值", threshold), field("审批模型（留空跟随当前会话模型）", model), status, field("模型超时（毫秒）", timeout), saveButton, retryButton, note);
      root.append(page); controls = { auto, full, readonly, threshold, model, timeout, confirm, acknowledge, risk, summary, save: saveButton, retry: retryButton, modelStatus: status, notice: note }; updateRisk(); retryButton.disabled = Boolean(activeSave); console.info("approvals.settings.mount"); if (activeSave) activeSave.reloadQueued = true; else void load();
    }
    return { mount(nextRoot, nextContext) { themeSubscription?.dispose(); disposed = false; lifecycleRevision += 1; root = nextRoot; contextKey = settingsContextKey(nextContext); build(); applyTheme({}); themeSubscription = host.onTheme((theme) => applyTheme(theme)); }, update(nextContext) { const nextContextKey = settingsContextKey(nextContext); if (nextContextKey === contextKey) return; contextKey = nextContextKey; if (activeSave?.lifecycle === lifecycleRevision) { activeSave.reloadQueued = true; return; } return load(); }, dispose() { console.debug("approvals.settings.dispose"); disposed = true; lifecycleRevision += 1; if (activeSave) activeSave.reloadQueued = false; themeSubscription?.dispose(); } };
  }
  console.debug("approvals.activate", { surface: host.context?.kind === "settings-page" ? "settings" : "workspace" });
  if (host.context?.kind === "settings-page") return settingsPage();
  let root; let context = host.context; let controls; let themeSubscription; let timer; let debounce; let state = { session: undefined, revision: 0, mountRevision: 0, rows: undefined, stats: undefined, autoRefresh: false, detailRequestId: undefined, detailFingerprint: undefined, refreshInFlight: false, refreshQueued: false, disposed: false, tool: "", decision: "", window: "all" };
  const status = (message, failed = false) => { controls.status.textContent = message; controls.status.dataset.tone = failed ? "error" : ""; };
  const invalidate = () => { state.revision += 1; };
  const showStats = () => {
    controls.summary.replaceChildren(); const stats = state.stats; const rate = stats ? `${(Number(stats.allow_rate) * 100).toFixed(1)}%` : "—";
    for (const [label, value] of [["总数", stats ? stats.approval_request_count : "—"], ["允许", stats ? stats.allowed_count : "—"], ["拒绝", stats ? stats.denied_count : "—"], ["人工", stats ? stats.manual_review_count : "—"], ["绕过", stats ? stats.bypass_count : "—"], ["放行率", rate]]) { const card = element("div", "approval-stat"); card.append(element("div", "approval-label", label), element("div", "approval-value", text(value))); controls.summary.append(card); }
  };
  const closeDetail = () => { state.detailRequestId = undefined; state.detailFingerprint = undefined; controls.drawer.hidden = true; controls.drawer.replaceChildren(); };
  const showDetail = (row) => {
    const panel = element("section", "approval-drawer-panel"); const head = element("header", "approval-drawer-head"); const close = element("button", "approval-button", "关闭"); const view = renderDetail(row);
    state.detailFingerprint = detailFingerprint(row); close.onclick = closeDetail; head.append(element("h2", "approval-card-title", "本会话审批详情"), close); panel.append(head, view.decision, view.details); controls.drawer.replaceChildren(panel); controls.drawer.hidden = false;
  };
  const openDetail = (row) => { state.detailRequestId = row.request_id; showDetail(row); };
  const refreshOpenDetail = () => {
    if (!state.detailRequestId) return;
    const row = state.rows?.find((candidate) => candidate.request_id === state.detailRequestId);
    if (!row) return closeDetail();
    if (state.detailFingerprint !== detailFingerprint(row) || controls.drawer.hidden) showDetail(row);
  };
  const showRows = () => {
    controls.list.replaceChildren(); const rows = state.rows;
    if (!rows?.length) return controls.list.append(element("div", "approval-empty", rows ? "本会话暂无审批记录" : "尚未加载审批记录"));
    for (const row of rows) { const [label, tone] = decisionInfo(row); const card = element("button", "approval-row"); card.type = "button"; card.setAttribute("aria-label", `查看 ${text(row.tool_name)} 的审批详情`); const head = element("span", "approval-row-title"); const meta = [MODES[row.mode] || row.mode, row.risk_level ? `风险：${RISKS[row.risk_level] || row.risk_level}` : ""].filter(Boolean).join(" · "); head.append(element("strong", "", text(row.tool_name)), element("span", `approval-badge ${tone}`, label)); card.append(head, element("span", "approval-meta", meta), element("span", "approval-preview", text(row.command_preview || row.reason || "无补充说明")), element("span", "approval-meta", formatTime(row.created_at))); card.onclick = () => openDetail(row); controls.list.append(card); }
  };
  const render = () => { showStats(); showRows(); refreshOpenDetail(); };
  const resetSession = (session) => { invalidate(); state.session = session; state.rows = undefined; state.stats = undefined; state.autoRefresh = false; closeDetail(); render(); };
  const validate = (rows, stats, session) => {
    const statisticKeys = ["approval_request_count", "allowed_count", "denied_count", "manual_review_count", "bypass_count", "allow_rate"];
    if (!Array.isArray(rows) || !isRecord(stats) || statisticKeys.some((key) => !Number.isFinite(stats[key])) || rows.some((row) => !isRecord(row) || row.session_id !== session)) throw new Error("审批主机返回了无效的会话数据");
    return { rows, stats };
  };
  async function refresh(options = {}) {
    const queueIfInFlight = options.queueIfInFlight !== false; const silent = options.silent === true; const mountRevision = state.mountRevision; const session = sessionIdFrom(context);
    if (!session) { resetSession(undefined); state.refreshQueued = false; controls.refresh.disabled = false; status("进入会话后查看该会话的审批记录。"); return; }
    if (session !== state.session) resetSession(session);
    if (state.refreshInFlight) { if (queueIfInFlight) state.refreshQueued = true; return; }
    const revision = ++state.revision; state.refreshInFlight = true;
    if (!silent) { controls.refresh.disabled = true; status("正在加载本会话审批记录…"); }
    try {
      const sinceMs = state.window === "all" ? undefined : Date.now() - WINDOW_MS[state.window];
      const [list, stats] = await Promise.all([host.request("xsec.approvals.list", { decision: state.decision || undefined, toolName: state.tool || undefined, sinceMs, limit: 200 }), host.request("xsec.approvals.statistics", state.window === "all" ? {} : { window: state.window })]);
      if (mountRevision !== state.mountRevision || revision !== state.revision || state.session !== session) return; const result = validate(list, stats, session); state.rows = result.rows; state.stats = result.stats; state.autoRefresh = true; render(); if (!silent) status("");
    } catch (error) { if (mountRevision !== state.mountRevision || revision !== state.revision || state.session !== session) return; state.autoRefresh = false; logFailure("approvals.workspace.refresh.failed", error); status(silent ? "自动刷新已暂停；请点击刷新重试。" : `加载本会话审批记录失败：${errorText(error)}`, true); } finally {
      if (mountRevision !== state.mountRevision || state.disposed) return;
      state.refreshInFlight = false; const queued = state.refreshQueued; state.refreshQueued = false;
      if (queued) { void refresh(); return; }
      controls.refresh.disabled = false;
    }
  }
  const later = () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      console.info("approvals.workspace.tool-filter.applied", { hasValue: Boolean(state.tool) });
      void refresh();
    }, FILTER_DEBOUNCE_MS);
  };
  function build() {
    root.replaceChildren(); addStyles(root); const page = element("section", "xsec-approvals"); const summary = element("div", "approval-card approval-summary"); const card = element("section", "approval-card"); const head = element("header", "approval-card-head"); const refreshButton = element("button", "approval-button", "刷新"); refreshButton.type = "button"; refreshButton.onclick = () => { console.info("approvals.workspace.refresh.requested"); void refresh(); }; head.append(element("h1", "approval-card-title", "本会话审批记录"), refreshButton);
    const toolbar = element("div", "approval-toolbar"); const windowGroup = element("span", "approval-toolbar"); const select = element("select", "approval-select"); const input = element("input", "approval-input"); input.placeholder = "工具名"; input.type = "search"; [["", "决策"], ...FILTER_DECISIONS.map((key) => [key, DECISIONS[key][0]])].forEach(([value, label]) => { const option = element("option", "", label); option.value = value; select.append(option); });
    for (const [value, label] of WINDOWS) { const button = element("button", "approval-button approval-window", label); button.type = "button"; button.dataset.value = value; button.onclick = () => { if (state.window !== value) { console.info("approvals.workspace.window.changed", { window: value }); state.window = value; invalidate(); updateWindows(); void refresh(); } }; windowGroup.append(button); }
    select.value = state.decision; input.value = state.tool; select.onchange = () => { console.info("approvals.workspace.decision.changed", { decision: select.value || "all" }); state.decision = select.value; invalidate(); void refresh(); }; input.oninput = () => { state.tool = input.value.trim(); invalidate(); later(); }; toolbar.append(windowGroup, select, input); const stateText = element("p", "approval-status"); const list = element("div", "approval-list"); const drawer = element("aside", "approval-drawer"); drawer.hidden = true; drawer.onclick = (event) => { if (event.target === drawer) closeDetail(); }; card.append(head, toolbar, stateText, list); page.append(summary, card, drawer); root.append(page); controls = { summary, list, status: stateText, refresh: refreshButton, drawer, windows: windowGroup.querySelectorAll("button") }; updateWindows(); render(); console.info("approvals.workspace.mount");
  }
  function updateWindows() { controls.windows.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.value === state.window))); }
  return { mount(nextRoot, nextContext) { window.clearInterval(timer); window.clearTimeout(debounce); themeSubscription?.dispose(); state.disposed = false; state.refreshQueued = false; state.refreshInFlight = false; state.mountRevision += 1; root = nextRoot; context = nextContext; build(); applyTheme({}); themeSubscription = host.onTheme((theme) => applyTheme(theme)); const mountRevision = state.mountRevision; timer = window.setInterval(() => { if (mountRevision === state.mountRevision && state.autoRefresh && !state.refreshInFlight && document.visibilityState === "visible") void refresh({ queueIfInFlight: false, silent: true }); }, AUTO_REFRESH_INTERVAL_MS); return refresh(); }, update(nextContext) { context = nextContext; if (sessionIdFrom(nextContext) !== state.session) { console.debug("approvals.workspace.context.changed"); return refresh(); } }, dispose() { console.debug("approvals.workspace.dispose"); state.disposed = true; state.refreshQueued = false; state.refreshInFlight = false; state.mountRevision += 1; invalidate(); window.clearInterval(timer); window.clearTimeout(debounce); themeSubscription?.dispose(); } };
}
