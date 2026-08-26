// XSEC Frontend API v2 — single-file ESM with no external imports.
// The opaque sandbox receives no Tauri API. Data access is limited to the
// two manifest-declared, session-bound read RPCs requested below.

const DECISIONS = {
  allowed: ["允许", "success"],
  denied: ["拒绝", "danger"],
  manual_review: ["人工审批", "warning"],
  bypass: ["绕过", "warning"],
  error: ["错误", "danger"],
};

const WINDOWS = [["all", "全部"], ["24h", "24 小时"], ["7d", "7 天"], ["30d", "30 天"]];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function sessionIdFrom(context) {
  const session = context?.workspace?.session;
  return typeof session?.session_id === "string" && session.session_id ? session.session_id : undefined;
}

function formatTime(value) {
  const timestamp = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString("zh-CN") : "—";
}

function addStyles(root) {
  const style = element("style");
  style.textContent = `
    :root { color: #d7dee8; font: 13px/1.45 var(--xsec-font-family, system-ui, sans-serif); }
    .xsec-approvals { min-height: 100%; padding: 12px; color: #d7dee8; }
    .xsec-approvals * { box-sizing: border-box; }
    .xsec-approvals-header { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
    .xsec-approvals-title { margin: 0; font-size: 15px; }
    .xsec-approvals-subtitle, .xsec-approvals-status, .xsec-approvals-meta { color: #9aa7b7; font-size: 12px; }
    .xsec-approvals-subtitle { margin: 2px 0 0; }
    .xsec-approvals-button, .xsec-approvals-select { border: 1px solid #3b4657; border-radius: 6px; padding: 5px 8px; color: inherit; background: #18212d; font: inherit; }
    .xsec-approvals-button { cursor: pointer; }
    .xsec-approvals-button:disabled { cursor: wait; opacity: .65; }
    .xsec-approvals-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 7px; margin-bottom: 12px; }
    .xsec-approvals-stat, .xsec-approvals-row { border: 1px solid #303b4c; border-radius: 7px; padding: 8px; background: #111924; }
    .xsec-approvals-stat-label { color: #9aa7b7; font-size: 11px; }
    .xsec-approvals-stat-value { margin-top: 2px; overflow: hidden; font-size: 18px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
    .xsec-approvals-toolbar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 9px; }
    .xsec-approvals-status { min-height: 20px; margin: 0 0 8px; }
    .xsec-approvals-status[data-tone="error"] { color: #ff8e8e; }
    .xsec-approvals-list { display: grid; gap: 7px; }
    .xsec-approvals-row-title { display: flex; justify-content: space-between; gap: 8px; }
    .xsec-approvals-row-title strong, .xsec-approvals-preview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .xsec-approvals-badge { flex: none; border-radius: 999px; padding: 1px 6px; font-size: 11px; }
    .xsec-approvals-badge.success { color: #82e6a8; background: #163a29; }
    .xsec-approvals-badge.warning { color: #ffd17a; background: #453318; }
    .xsec-approvals-badge.danger { color: #ff9999; background: #4a2027; }
    .xsec-approvals-preview { display: block; margin-top: 4px; color: #9aa7b7; }
    .xsec-approvals-empty { border: 1px dashed #3b4657; border-radius: 7px; padding: 22px 10px; color: #9aa7b7; text-align: center; }
    @media (max-width: 300px) { .xsec-approvals-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  `;
  root.append(style);
}

export function activate(host) {
  let root;
  let context = host.context;
  let boundSession;
  let revision = 0;
  let decision = "";
  let windowKey = "all";
  let controls;

  function setStatus(message, tone) {
    controls.status.textContent = message;
    controls.status.dataset.tone = tone || "";
  }

  function renderStats(stats) {
    controls.summary.replaceChildren();
    const values = [
      ["总数", stats?.approval_request_count ?? 0], ["允许", stats?.allowed_count ?? 0], ["拒绝", stats?.denied_count ?? 0],
      ["人工", stats?.manual_review_count ?? 0], ["绕过", stats?.bypass_count ?? 0], ["放行率", `${(Number(stats?.allow_rate ?? 0) * 100).toFixed(1)}%`],
    ];
    for (const [label, value] of values) {
      const stat = element("div", "xsec-approvals-stat");
      stat.append(element("div", "xsec-approvals-stat-label", label), element("div", "xsec-approvals-stat-value", String(value)));
      controls.summary.append(stat);
    }
  }

  function renderRows(rows) {
    controls.list.replaceChildren();
    if (!rows.length) {
      controls.list.append(element("div", "xsec-approvals-empty", "本会话暂无审批记录"));
      return;
    }
    for (const row of rows) {
      const card = element("article", "xsec-approvals-row");
      const title = element("div", "xsec-approvals-row-title");
      const [label, tone] = DECISIONS[row.final_decision || row.decision] || [row.final_decision || row.decision || "未知", ""];
      title.append(element("strong", "", row.tool_name || "未知工具"), element("span", `xsec-approvals-badge ${tone}`, label));
      const meta = [row.mode, row.risk_level ? `风险：${row.risk_level}` : ""].filter(Boolean).join(" · ");
      card.append(title, element("span", "xsec-approvals-meta", meta), element("span", "xsec-approvals-preview", row.command_preview || row.reason || "无补充说明"), element("span", "xsec-approvals-meta", formatTime(row.created_at)));
      controls.list.append(card);
    }
  }

  async function refresh() {
    const sessionId = sessionIdFrom(context);
    if (!sessionId) {
      boundSession = undefined;
      renderStats();
      renderRows([]);
      setStatus("进入会话后查看该会话的审批记录。");
      return;
    }
    boundSession = sessionId;
    const current = ++revision;
    controls.refresh.disabled = true;
    setStatus("正在加载本会话审批记录…");
    try {
      const sinceMs = windowKey === "all" ? undefined : Date.now() - ({ "24h": 86400000, "7d": 604800000, "30d": 2592000000 }[windowKey]);
      const [rows, stats] = await Promise.all([
        host.request("xsec.approvals.list", { decision: decision || undefined, sinceMs, limit: 200 }),
        host.request("xsec.approvals.statistics", windowKey === "all" ? {} : { window: windowKey }),
      ]);
      if (current !== revision || boundSession !== sessionId) return;
      renderRows(Array.isArray(rows) ? rows : []);
      renderStats(stats && typeof stats === "object" ? stats : undefined);
      setStatus("");
    } catch (error) {
      if (current !== revision || boundSession !== sessionId) return;
      renderRows([]);
      renderStats();
      setStatus(`加载本会话审批记录失败：${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      if (current === revision) controls.refresh.disabled = false;
    }
  }

  function build() {
    root.replaceChildren();
    const container = element("section", "xsec-approvals");
    const header = element("header", "xsec-approvals-header");
    const titles = element("div");
    titles.append(element("h1", "xsec-approvals-title", "审批记录"), element("p", "xsec-approvals-subtitle", "仅显示当前会话的已脱敏审批审计记录"));
    const refreshButton = element("button", "xsec-approvals-button", "刷新");
    refreshButton.type = "button";
    refreshButton.addEventListener("click", () => { void refresh(); });
    header.append(titles, refreshButton);
    const summary = element("div", "xsec-approvals-summary");
    const toolbar = element("div", "xsec-approvals-toolbar");
    const decisionSelect = element("select", "xsec-approvals-select");
    [["", "全部决策"], ...Object.entries(DECISIONS).map(([key, [label]]) => [key, label])].forEach(([value, label]) => {
      const option = element("option", "", label); option.value = value; decisionSelect.append(option);
    });
    decisionSelect.addEventListener("change", () => { decision = decisionSelect.value; void refresh(); });
    const windowSelect = element("select", "xsec-approvals-select");
    WINDOWS.forEach(([value, label]) => { const option = element("option", "", label); option.value = value; windowSelect.append(option); });
    windowSelect.addEventListener("change", () => { windowKey = windowSelect.value; void refresh(); });
    toolbar.append(decisionSelect, windowSelect);
    const status = element("p", "xsec-approvals-status");
    const list = element("div", "xsec-approvals-list");
    container.append(header, summary, toolbar, status, list);
    root.append(container);
    addStyles(root);
    controls = { summary, status, list, refresh: refreshButton };
  }

  return {
    mount(nextRoot, nextContext) {
      root = nextRoot;
      context = nextContext;
      build();
      return refresh();
    },
    update(nextContext) {
      context = nextContext;
      if (sessionIdFrom(nextContext) !== boundSession) return refresh();
    },
    dispose() {
      revision += 1;
      boundSession = undefined;
    },
  };
}
