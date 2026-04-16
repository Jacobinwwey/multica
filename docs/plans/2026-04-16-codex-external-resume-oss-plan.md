# Codex External Resume OSS PR Plan (2026-04-16)

## 中文部分（Chinese Section）

### 1. 背景与目标
- 目标仓库：`https://github.com/Jacobinwwey/multica`（fork）
- 当前目标：先把可运行改动推送到 fork，随后按顶级 OSS 规范拆分上游 PR。
- 本轮改动覆盖：
  - 外部 Codex 会话读取（`~/.codex/sessions`）
  - 外部会话继续执行（Continue）
  - Manual resume 任务生命周期打通（无 issue 也可执行）
  - Agent/Runtime 可观测性增强（Codex 3d/7d 过滤、Last Seen）

### 2. 按原子性拆分的 PR 分类与方向

#### PR-A（Feature）
- 分类：`feat`
- 建议标题：`feat(agent-resume): add external codex session discovery and resume API`
- 范围（单一职责）：
  - 后端新增外部会话查询与恢复接口
  - 前端 `Tasks` 展示 `Resume Sessions (7d)` 并支持 Continue
  - 配置与部署（compose/env）支持挂载宿主机 `.codex`
- 关键文件：
  - `server/internal/handler/agent.go`
  - `server/cmd/server/router.go`
  - `packages/views/agents/components/tabs/tasks-tab.tsx`
  - `packages/core/api/client.ts`
  - `packages/core/types/agent.ts`
  - `docker-compose.selfhost.yml`
  - `.env.example`
- 权衡：
  - 采用“文件系统扫描 sessions”而非“依赖 codex interactive 命令”，可在容器中稳定运行。
  - 代价是需要只读挂载宿主目录，增加部署配置要求。

#### PR-B（Bugfix）
- 分类：`fix`
- 建议标题：`fix(task-lifecycle): resolve workspace for manual resume tasks`
- 范围（单一职责）：
  - 修复无 `issue_id` 的 manual resume 任务在 daemon 生命周期接口中无法通过权限校验的问题
  - 打通 start/progress/complete/fail 全链路
- 关键文件：
  - `server/internal/handler/daemon.go`
  - `server/internal/service/task.go`
- 根因：
  - 旧逻辑仅从 `issue/chat` 推导 workspace，manual resume 无 issue/chat，导致 `requireDaemonTaskAccess` 返回 404。
- 回归风险：
  - 低。仅新增 fallback（`agent.workspace`）不改变 issue/chat 既有路径。

#### PR-C（Feature, UI/Observability）
- 分类：`feat`
- 建议标题：`feat(agents-ui): add codex recency filters and runtime last-seen indicators`
- 范围（单一职责）：
  - Agent 列表支持 `All / Codex 7d / Codex 3d`
  - Runtime 列表增加 `Last seen` 文案与 `7d` 标记
- 关键文件：
  - `packages/views/agents/components/agents-page.tsx`
  - `packages/views/runtimes/components/runtime-list.tsx`
- 权衡：
  - 增强可见性，帮助定位活跃运行时；代价是 UI 状态分支稍增。

### 3. Git 与提交策略（严格遵循）
- 分支策略：
  - `feature/external-codex-resume`（PR-A）
  - `fix/manual-resume-lifecycle`（PR-B）
  - `feature/codex-runtime-observability`（PR-C）
- Commit 规范：
  - 使用 Conventional Commits：`type(scope): description`
  - 必须 DCO：`git commit -s`
- Review 期策略：
  - 修复 reviewer 问题时优先追加 `fixup!` commit，保留增量可读性
  - 合并前再执行 `rebase -i` 清理历史

### 4. 验证与质量门禁
- 必做项：
  - Frontend build/typecheck 通过
  - Backend build 通过
  - 至少 1 条 manual resume 的端到端链路验证（入队 -> claim -> start -> complete/fail）
- 已验证证据（当前实现）：
  - 远端容器重建成功（backend/frontend）
  - backend 容器可读取 `/codex-host/sessions`
  - `agent_task_queue` 中 manual resume 任务已可被 runtime claim/消费

### 5. 兼容性与风险
- 向后兼容：
  - 现有 issue/chat 任务流保持不变
  - 新增接口为增量，不破坏既有 API
- 部署风险点：
  - 若未配置 `MULTICA_HOST_CODEX_HOME` 或 `MULTICA_CODEX_SESSIONS_ROOT`，外部会话列表会为空

### 6. 上游提交前的强制操作
- 在准备上游 PR 描述前，执行：
  - `git fetch upstream && git rebase upstream/main`
- 禁止向上游 PR 引入 merge commit。

---

## English Section

### 1. Context and Goal
- Target fork: `https://github.com/Jacobinwwey/multica`
- Immediate goal: publish runnable changes to the fork first, then split upstream PRs with strict OSS hygiene.
- Covered scope:
  - External Codex session discovery from `~/.codex/sessions`
  - Continue/resume from concrete sessions
  - Manual resume lifecycle fix (no issue binding required)
  - Agent/runtime observability enhancements (Codex 3d/7d, Last Seen)

### 2. PR Taxonomy and Direction (Atomic Scope)

#### PR-A (Feature)
- Type: `feat`
- Suggested title: `feat(agent-resume): add external codex session discovery and resume API`
- Single responsibility:
  - New backend APIs for external session listing/resume
  - `Tasks` tab supports `Resume Sessions (7d)` and Continue
  - Compose/env support for host `.codex` read-only mount
- Key files:
  - `server/internal/handler/agent.go`
  - `server/cmd/server/router.go`
  - `packages/views/agents/components/tabs/tasks-tab.tsx`
  - `packages/core/api/client.ts`
  - `packages/core/types/agent.ts`
  - `docker-compose.selfhost.yml`
  - `.env.example`
- Trade-off:
  - Chose filesystem rollout scanning over interactive CLI calls for container-safe reliability.
  - Cost: explicit deployment mount/env requirements.

#### PR-B (Bugfix)
- Type: `fix`
- Suggested title: `fix(task-lifecycle): resolve workspace for manual resume tasks`
- Single responsibility:
  - Fix daemon access/lifecycle checks for tasks with no `issue_id`
  - Unblock start/progress/complete/fail for manual resume
- Key files:
  - `server/internal/handler/daemon.go`
  - `server/internal/service/task.go`
- Root cause:
  - Workspace resolution previously depended only on issue/chat context, which is absent in manual resume tasks.
- Regression risk:
  - Low. Adds `agent.workspace` fallback without changing existing issue/chat flows.

#### PR-C (Feature, UI/Observability)
- Type: `feat`
- Suggested title: `feat(agents-ui): add codex recency filters and runtime last-seen indicators`
- Single responsibility:
  - Agent list filters: `All / Codex 7d / Codex 3d`
  - Runtime list `Last seen` and `7d` badge
- Key files:
  - `packages/views/agents/components/agents-page.tsx`
  - `packages/views/runtimes/components/runtime-list.tsx`
- Trade-off:
  - Better operational visibility with modest UI state complexity.

### 3. Git and Commit Policy
- Branching:
  - `feature/external-codex-resume` (PR-A)
  - `fix/manual-resume-lifecycle` (PR-B)
  - `feature/codex-runtime-observability` (PR-C)
- Commits:
  - Use Conventional Commits
  - Always include DCO: `git commit -s`
- Review-phase workflow:
  - Prefer additive `fixup!` commits for reviewer visibility
  - Squash/clean with `rebase -i` only before final merge

### 4. Validation Gates
- Required:
  - Frontend build/typecheck passes
  - Backend build passes
  - At least one manual resume E2E chain validated (enqueue -> claim -> start -> complete/fail)
- Current evidence:
  - Remote backend/frontend containers rebuilt successfully
  - Backend container reads `/codex-host/sessions`
  - Manual resume tasks are now claimable and processable by runtime

### 5. Compatibility and Risk
- Backward compatibility:
  - Existing issue/chat task flows are unchanged
  - New APIs are additive and non-breaking
- Deployment risk:
  - External sessions stay empty if host codex mount/env is not configured

### 6. Mandatory Upstream Sync Step
- Before opening upstream PR:
  - `git fetch upstream && git rebase upstream/main`
- Do not push merge commits into upstream PR branches.
