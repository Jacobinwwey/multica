# Host-Codex Resume Chain PR Strategy (Multica)

## 中文（Chinese）

### 背景与目标

本轮需求聚焦一个主能力：让 Windows 端用户可在 Multica 前端直接发现并操作 Ubuntu 宿主机上正在运行或可恢复的 Codex 会话，并将 `Continue` 行为稳定映射到 `Issues / My Issues`，避免“点了继续但看不到任务”的断链体验。

### 原子化 PR 拆分（符合单一职责）

#### PR-A（核心后端链路）

- **Title:** `feat(server): bridge external codex sessions into resumable issue workflow`
- **Scope:**
  - 新增 external session 发现与聚合能力（运行中进程 + session file）。
  - 暴露 `/api/agents/{id}/external-sessions`。
  - `Continue` 支持显式 issue 绑定或自动创建 issue。
  - 将 `resume_session_id / resume_source / resume_command` 写入 task context，打通后续显示链路。
  - 补齐后端回归测试（handler/listener/notification 相关）。
- **Non-goals:**
  - 不改动 UI 视觉样式。
  - 不引入新的工作流编排系统。
- **Risk:**
  - 多次 Continue 或并发 Continue 导致重复 issue。
  - 外部会话状态抖动导致 issue 绑定漂移。
- **Mitigation:**
  - 优先绑定已存在 issue；自动创建路径幂等化。
  - 通过 task context 中 session 元信息保持可追踪性。

#### PR-B（前端任务可操作性）

- **Title:** `feat(agents-ui): add resumable external session operations in Tasks tab`
- **Scope:**
  - Agents `Tasks` 页展示 `Resume Sessions (7d)`。
  - 支持 `Continue`、`Bind issue`、`Copy ID`、状态标签（running/last seen/source）。
  - Continue 后在 UI 中即时反映 issue 关联状态。
  - 同步 `Inbox / Issue detail` 标签文案，减少链路理解成本。
  - 增加 e2e 覆盖关键路径（Tasks 可打开、Continue 可触发、Issue 可出现）。
- **Non-goals:**
  - 不重构整个 Agents 信息架构。
  - 不引入新的前端状态库。
- **Risk:**
  - Modal/confirm 流程阻塞自动化。
  - 多次点击造成误操作。
- **Mitigation:**
  - 明确确认弹窗与错误提示。
  - 前端状态刷新与后端结果保持一致，避免“假成功”。

#### PR-C（自托管与提权安全能力）

- **Title:** `feat(selfhost): add optional host-codex elevation compose profile`
- **Scope:**
  - 新增 `docker-compose.selfhost.host-codex.yml` 覆盖文件。
  - 新增 `Makefile` 目标：`selfhost-host-codex` / `selfhost-host-codex-stop`。
  - `.env.example` 增加最小必要变量与默认安全值（默认不开启 privileged toggle）。
  - 通过只读挂载 `/proc` + `CAP_SYS_PTRACE` 提供宿主会话可见性。
- **Non-goals:**
  - 不默认启用提权；必须显式启用。
  - 不在未授权环境下自动提权。
- **Risk:**
  - 提权能力误用。
- **Mitigation:**
  - 明确安全提示、可逆开关、默认关闭自动提权。

### Commit 规范（Conventional Commits + DCO）

- 每个 PR 至少包含以下逻辑分块（按需要）：
  - `feat(...)`
  - `test(...)`
  - `docs(...)`
- 所有 commit 使用 `git commit -s`，确保 `Signed-off-by`。

### 验证矩阵（合并前必须完成）

- 后端：
  - `go test ./internal/handler ./cmd/server ./internal/service`
- 前端：
  - 受影响包 `typecheck/lint`（`core/views/web`）
- 端到端：
  - Playwright 验证 `Agents -> Tasks -> Continue -> Issues/My Issues`
- 部署：
  - `docker compose ... up -d --build`
  - `/health` 为 `ok`

### 向后兼容与破坏性评估

- 本方案不引入公开 API 的破坏性变更；新增字段与端点均为增量兼容。
- 未发现必须声明 `BREAKING CHANGE` 的条目。

### 提交流程建议（Review 友好）

1. `git fetch upstream && git rebase upstream/main`
2. 按 PR-A/B/C 原子拆分提交，避免混合改动。
3. Review 阶段使用增量 commit（可 `fixup!`），避免早期强制 squash。
4. Merge 前再 `rebase -i` 清理历史并 force push。

---

## English

### Context & Goal

This initiative delivers one core capability: allow Windows users to directly discover and operate Codex sessions running on a remote Ubuntu host from Multica UI, with a reliable `Continue -> Issue/My Issues` mapping so users never lose task visibility after clicking Continue.

### Atomic PR Breakdown (Single Responsibility)

#### PR-A (Core Backend Chain)

- **Title:** `feat(server): bridge external codex sessions into resumable issue workflow`
- **Scope:**
  - Add external session discovery and merge (live process + session file).
  - Expose `/api/agents/{id}/external-sessions`.
  - Support explicit issue binding or auto-create issue on Continue.
  - Persist `resume_session_id / resume_source / resume_command` in task context for downstream visibility.
  - Add regression coverage for handler/listener/notification paths.
- **Non-goals:**
  - No UI redesign.
  - No new orchestration framework.
- **Risk:**
  - Duplicate issues under repeated/concurrent Continue.
  - Session state drift causing issue mismatch.
- **Mitigation:**
  - Prefer binding to existing issue when available; keep auto-create idempotent.
  - Preserve session metadata in task context for traceability.

#### PR-B (Frontend Operability)

- **Title:** `feat(agents-ui): add resumable external session operations in Tasks tab`
- **Scope:**
  - Show `Resume Sessions (7d)` in Agent Tasks.
  - Provide `Continue`, `Bind issue`, `Copy ID`, and state badges.
  - Reflect issue association immediately after Continue.
  - Align Inbox/Issue labels to reduce user confusion.
  - Add e2e coverage for open Tasks, Continue action, and issue visibility.
- **Non-goals:**
  - No full IA refactor of Agents.
  - No new state management library.
- **Risk:**
  - Modal confirmation blocks automation.
  - Multi-click races and user confusion.
- **Mitigation:**
  - Explicit confirmations and actionable errors.
  - UI refresh driven by backend truth, not optimistic fake success.

#### PR-C (Self-host + Privilege Safety)

- **Title:** `feat(selfhost): add optional host-codex elevation compose profile`
- **Scope:**
  - Add `docker-compose.selfhost.host-codex.yml` override.
  - Add `Makefile` targets: `selfhost-host-codex` / `selfhost-host-codex-stop`.
  - Add minimal env knobs in `.env.example` with safe defaults.
  - Enable host visibility via read-only `/proc` mount + `CAP_SYS_PTRACE`.
- **Non-goals:**
  - No default privileged mode.
  - No unattended elevation in untrusted contexts.
- **Risk:**
  - Misuse of elevated capabilities.
- **Mitigation:**
  - Security notice, explicit opt-in, reversible toggle, safe defaults.

### Commit Policy (Conventional Commits + DCO)

- Each PR should be logically chunked with:
  - `feat(...)`
  - `test(...)`
  - `docs(...)`
- All commits must be signed with `git commit -s`.

### Validation Matrix (Pre-merge)

- Backend:
  - `go test ./internal/handler ./cmd/server ./internal/service`
- Frontend:
  - Typecheck/lint for impacted packages (`core/views/web`)
- E2E:
  - Playwright flow: `Agents -> Tasks -> Continue -> Issues/My Issues`
- Deployment:
  - `docker compose ... up -d --build`
  - `/health` returns `ok`

### Backward Compatibility

- No public breaking API changes introduced; endpoints/fields are additive.
- No item currently requires `BREAKING CHANGE`.

### Review Workflow Recommendation

1. `git fetch upstream && git rebase upstream/main`
2. Keep PR-A/B/C atomic and non-overlapping.
3. During review, prefer incremental fix commits (`fixup!` optional), avoid early squashing.
4. Before merge, run `rebase -i` for linear history, then force push once.

