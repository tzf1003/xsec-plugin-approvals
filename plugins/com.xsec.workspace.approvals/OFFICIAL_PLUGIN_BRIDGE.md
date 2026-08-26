# Official plugin bridge

This package owns the signed plugin manifest, permissions and release lifecycle.
XSEC Desktop binds its compatible renderer only after the package is installed
and enabled; package state is therefore the source of truth.

## 设置审查

默认审批策略、完全访问授权、本地只读放行、审批模型、低置信度阈值和超时位于
“设置 → 插件 → 审批记录”。授权与规则保存后立即生效，而新会话默认策略仅影响
后续会话；当前会话的审批记录和筛选保留在主界面。详见仓库的
[插件设置规范](../../docs/plugin-settings.md)。
