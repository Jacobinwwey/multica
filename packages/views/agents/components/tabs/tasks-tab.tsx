"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { ListTodo, RotateCcw, Copy } from "lucide-react";
import type { Agent, AgentExternalSession, AgentTask } from "@multica/core/types";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { Button } from "@multica/ui/components/ui/button";
import { api } from "@multica/core/api";
import { useAuthStore } from "@multica/core/auth";
import { useWorkspaceId } from "@multica/core/hooks";
import { issueListOptions } from "@multica/core/issues/queries";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { taskStatusConfig } from "../../config";

type ResumeEntry = {
  session_id: string;
  work_dir?: string;
  issue_id?: string;
  source_task_id?: string;
  source: "task" | "external";
  timestamp: string;
};

type ResumeIssueHint = {
  id: string;
  identifier: string;
  title: string;
};

function shortSessionId(sessionId: string): string {
  if (sessionId.length <= 20) return sessionId;
  return `${sessionId.slice(0, 8)}...${sessionId.slice(-8)}`;
}

function extractResumeSessionFromIssue(issueTitle: string, issueDescription?: string | null): string {
  const fullText = `${issueTitle}\n${issueDescription || ""}`;
  const match = fullText.match(
    /codex resume ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  return match?.[1]?.trim() || "";
}

function extractWorkDirFromIssueDescription(issueDescription?: string | null): string {
  if (!issueDescription) return "";
  const match = issueDescription.match(/^\s*Workdir:\s*(.+)\s*$/im);
  return match?.[1]?.trim() || "";
}

function isPendingTaskConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { status?: number; message?: string };
  if (maybeError.status === 409) return true;
  return (maybeError.message || "").toLowerCase().includes("pending task");
}

function isAlreadyBoundTaskConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { status?: number; message?: string };
  if (maybeError.status !== 409) return false;
  const message = (maybeError.message || "").toLowerCase();
  return message.includes("already bound") || message.includes("cannot be bound");
}

function resolveTaskResumeCommand(task: AgentTask): string | null {
  const explicitCommand = (task.resume_command || "").trim();
  if (explicitCommand) return explicitCommand;
  const resumeSessionID = (
    task.resume_session_id ||
    task.prior_session_id ||
    task.session_id ||
    ""
  ).trim();
  return resumeSessionID ? `codex resume ${resumeSessionID}` : null;
}

function resolveTaskResumeSessionId(task: AgentTask): string {
  return (
    task.resume_session_id ||
    task.prior_session_id ||
    task.session_id ||
    ""
  ).trim();
}

function isActiveTaskStatus(status: AgentTask["status"]): boolean {
  return status === "running" || status === "dispatched" || status === "queued";
}

export function TasksTab({ agent }: { agent: Agent }) {
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [externalSessions, setExternalSessions] = useState<AgentExternalSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [resumingSessionIds, setResumingSessionIds] = useState<Record<string, boolean>>({});
  const [issueBindingBySession, setIssueBindingBySession] = useState<Record<string, string>>({});
  const inFlightResumeSessionsRef = useRef<Set<string>>(new Set());
  const inFlightTaskIssueBindingsRef = useRef<Set<string>>(new Set());
  const attemptedTaskIssueBindingsRef = useRef<Set<string>>(new Set());
  const workspaceReposReadyRef = useRef<boolean | null>(null);
  const missingReposWarnedRef = useRef(false);
  const wsId = useWorkspaceId();
  const currentUser = useAuthStore((s) => s.user);
  const { data: issues = [], isFetched: issuesFetched } = useQuery(issueListOptions(wsId));

  const loadData = async (options?: { background?: boolean }) => {
    const background = options?.background === true;
    if (!background) {
      setLoading(true);
    }
    try {
      const [taskList, externalList] = await Promise.all([
        api.listAgentTasks(agent.id),
        api.listAgentExternalSessions(agent.id, { days: 7 }),
      ]);
      setTasks(taskList);
      setExternalSessions(externalList);
    } catch {
      if (!background) {
        setTasks([]);
        setExternalSessions([]);
      }
    } finally {
      if (!background) {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    void loadData();
  }, [agent.id]);

  useEffect(() => {
    workspaceReposReadyRef.current = null;
    missingReposWarnedRef.current = false;
  }, [wsId]);

  useEffect(() => {
    const activeTaskIDs = new Set(tasks.map((task) => task.id));
    attemptedTaskIssueBindingsRef.current.forEach((taskID) => {
      if (!activeTaskIDs.has(taskID)) {
        attemptedTaskIssueBindingsRef.current.delete(taskID);
      }
    });
  }, [tasks]);

  const sortedTasks = useMemo(
    () => {
      const statusRank: Record<AgentTask["status"], number> = {
        running: 0,
        dispatched: 1,
        queued: 2,
        completed: 3,
        failed: 3,
        cancelled: 3,
      };
      return [...tasks].sort((a, b) => {
        const aRank = statusRank[a.status];
        const bRank = statusRank[b.status];
        if (aRank !== bRank) return aRank - bRank;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
    },
    [tasks],
  );

  const issueMap = new Map(issues.map((i) => [i.id, i]));
  const bindableIssues = useMemo(
    () =>
      issues
        .filter(
          (issue) => issue.status !== "done" && issue.status !== "cancelled",
        )
        .sort(
          (a, b) =>
            Date.parse(b.updated_at || b.created_at) - Date.parse(a.updated_at || a.created_at),
        ),
    [issues],
  );

  const resumeIssueHintsBySession = useMemo(() => {
    const bySession = new Map<string, ResumeIssueHint>();

    for (const issue of bindableIssues) {
      const sid = extractResumeSessionFromIssue(issue.title, issue.description);
      if (!sid) continue;
      bySession.set(sid, {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
      });
    }
    return bySession;
  }, [bindableIssues]);

  const resumeIssueHintsByWorkDir = useMemo(() => {
    const byWorkDir = new Map<string, ResumeIssueHint>();

    for (const issue of bindableIssues) {
      const wd = extractWorkDirFromIssueDescription(issue.description);
      if (!wd) continue;
      byWorkDir.set(wd, {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
      });
    }
    return byWorkDir;
  }, [bindableIssues]);

  const externalSessionById = useMemo(() => {
    const bySession = new Map<string, AgentExternalSession>();
    for (const external of externalSessions) {
      if (!external.session_id) continue;
      bySession.set(external.session_id, external);
    }
    return bySession;
  }, [externalSessions]);

  const resumeEntries = useMemo(() => {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const bySession = new Map<string, ResumeEntry>();

    for (const external of externalSessions) {
      if (!external.session_id) continue;
      const seenAt = Date.parse(external.last_seen_at);
      if (!Number.isNaN(seenAt) && seenAt < sevenDaysAgo) continue;
      bySession.set(external.session_id, {
        session_id: external.session_id,
        work_dir: external.work_dir,
        issue_id: external.issue_id,
        source_task_id: external.source_task_id,
        source: "external",
        timestamp: external.last_seen_at,
      });
    }

    const taskCandidates = tasks
      .filter((task) => task.status === "completed" && !!task.session_id)
      .filter((task) => {
        const ts = Date.parse(task.completed_at ?? task.created_at);
        return !Number.isNaN(ts) && ts >= sevenDaysAgo;
      })
      .sort(
        (a, b) =>
          Date.parse(b.completed_at ?? b.created_at) -
          Date.parse(a.completed_at ?? a.created_at),
      );

    for (const task of taskCandidates) {
      const sessionId = task.session_id!;
      bySession.set(sessionId, {
        session_id: sessionId,
        work_dir: task.work_dir,
        issue_id: task.issue_id || undefined,
        source_task_id: task.id,
        source: "task",
        timestamp: task.completed_at ?? task.created_at,
      });
    }

    return [...bySession.values()].sort(
      (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
    );
  }, [tasks, externalSessions]);

  const ensureWorkspaceReposReady = useCallback(async (): Promise<boolean> => {
    if (workspaceReposReadyRef.current === true) return true;
    if (workspaceReposReadyRef.current === false) {
      if (!missingReposWarnedRef.current) {
        toast.error("Workspace has no repositories. Attach at least one repo in Settings > Repositories first.");
        missingReposWarnedRef.current = true;
      }
      return false;
    }

    try {
      const workspace = await api.getWorkspace(wsId);
      const repoCount = Array.isArray(workspace.repos) ? workspace.repos.length : 0;
      if (repoCount > 0) {
        workspaceReposReadyRef.current = true;
        return true;
      }

      workspaceReposReadyRef.current = false;
      if (!missingReposWarnedRef.current) {
        toast.error("Workspace has no repositories. Attach at least one repo in Settings > Repositories first.");
        missingReposWarnedRef.current = true;
      }
      return false;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to verify workspace repositories");
      return false;
    }
  }, [wsId]);

  useEffect(() => {
    if (!issuesFetched) return;

    const sessionIssueCache = new Map<string, string>();
    let cancelled = false;

    const syncRunningResumeTasksToIssues = async () => {
      const reposReady = await ensureWorkspaceReposReady();
      if (!reposReady) return;

      const activeResumeTasks = tasks.filter((task) => {
        if (task.issue_id) return false;
        if (task.chat_session_id) return false;
        if (!isActiveTaskStatus(task.status)) return false;
        return resolveTaskResumeSessionId(task) !== "";
      });
      if (activeResumeTasks.length === 0) return;

      let boundCount = 0;
      let createdIssueCount = 0;

      for (const task of activeResumeTasks) {
        if (cancelled) return;
        if (attemptedTaskIssueBindingsRef.current.has(task.id)) continue;
        if (inFlightTaskIssueBindingsRef.current.has(task.id)) continue;

        const resumeSessionID = resolveTaskResumeSessionId(task);
        if (!resumeSessionID) continue;

        attemptedTaskIssueBindingsRef.current.add(task.id);
        inFlightTaskIssueBindingsRef.current.add(task.id);

        try {
          const external = externalSessionById.get(resumeSessionID);
          const effectiveWorkDir = (task.work_dir || external?.work_dir || "").trim();

          let targetIssueID = (
            sessionIssueCache.get(resumeSessionID) ||
            external?.issue_id ||
            resumeIssueHintsBySession.get(resumeSessionID)?.id ||
            ""
          ).trim();

          if (!targetIssueID && effectiveWorkDir) {
            targetIssueID = (resumeIssueHintsByWorkDir.get(effectiveWorkDir)?.id || "").trim();
          }

          if (!targetIssueID) {
            const command = `codex resume ${resumeSessionID}`;
            const createdIssue = await api.createIssue({
              title: `Resume ${shortSessionId(resumeSessionID)} - ${command}`,
              description:
                `Auto-created for running resume task issue sync.\n\n` +
                `Command: ${command}\n` +
                `Workdir: ${effectiveWorkDir || "(unknown)"}`,
              status: "todo",
              priority: "none",
              assignee_type: currentUser?.id ? "member" : undefined,
              assignee_id: currentUser?.id || undefined,
            });
            targetIssueID = createdIssue.id;
            sessionIssueCache.set(resumeSessionID, targetIssueID);
            createdIssueCount += 1;
          }

          try {
            await api.bindAgentTaskIssue(agent.id, task.id, targetIssueID);
            boundCount += 1;
          } catch (bindErr) {
            if (isAlreadyBoundTaskConflict(bindErr)) {
              boundCount += 1;
              continue;
            }
            if (!isPendingTaskConflict(bindErr)) {
              throw bindErr;
            }

            const command = `codex resume ${resumeSessionID}`;
            const fallbackIssue = await api.createIssue({
              title: `Resume ${shortSessionId(resumeSessionID)} - ${command}`,
              description:
                `Auto-created after issue-binding conflict.\n\n` +
                `Command: ${command}\n` +
                `Workdir: ${effectiveWorkDir || "(unknown)"}`,
              status: "todo",
              priority: "none",
              assignee_type: currentUser?.id ? "member" : undefined,
              assignee_id: currentUser?.id || undefined,
            });
            await api.bindAgentTaskIssue(agent.id, task.id, fallbackIssue.id);
            sessionIssueCache.set(resumeSessionID, fallbackIssue.id);
            createdIssueCount += 1;
            boundCount += 1;
          }
        } catch (syncErr) {
          console.error("failed to auto-sync running task to issue", syncErr);
        } finally {
          inFlightTaskIssueBindingsRef.current.delete(task.id);
        }
      }

      if (cancelled) return;
      if (boundCount === 0) return;

      if (createdIssueCount > 0) {
        toast.info(`Auto-created ${createdIssueCount} issue(s) and synced running Codex task(s).`);
      }
      await loadData({ background: true });
    };

    void syncRunningResumeTasksToIssues();

    return () => {
      cancelled = true;
    };
  }, [
    agent.id,
    tasks,
    externalSessionById,
    resumeIssueHintsBySession,
    resumeIssueHintsByWorkDir,
    issuesFetched,
    currentUser?.id,
    ensureWorkspaceReposReady,
  ]);

  const copySessionId = async (sessionId: string) => {
    try {
      await navigator.clipboard.writeText(sessionId);
      toast.success("Session ID copied");
    } catch {
      toast.error("Failed to copy Session ID");
    }
  };

  const handleResume = async (entry: ResumeEntry) => {
    if (inFlightResumeSessionsRef.current.has(entry.session_id)) {
      toast.info("This session is already queueing.");
      return;
    }
    inFlightResumeSessionsRef.current.add(entry.session_id);
    setResumingSessionIds((prev) => ({ ...prev, [entry.session_id]: true }));
    try {
      const reposReady = await ensureWorkspaceReposReady();
      if (!reposReady) {
        return;
      }

      const selectedIssueId = issueBindingBySession[entry.session_id];
      const command = `codex resume ${entry.session_id}`;
      let effectiveIssueID = entry.issue_id || selectedIssueId;

      if (entry.issue_id && !selectedIssueId) {
        const existingIssue = issueMap.get(entry.issue_id);
        const existingLabel = existingIssue
          ? `${existingIssue.identifier} - ${existingIssue.title}`
          : `Issue ${entry.issue_id.slice(0, 8)}...`;
        const createNew = window.confirm(
          `This session is already linked to ${existingLabel}.\n\nPress OK to create a NEW issue, or Cancel to reuse the existing issue.`,
        );
        if (createNew) {
          effectiveIssueID = "";
        } else {
          toast.info(`Reusing ${existingLabel}`);
        }
      }

      if (!effectiveIssueID) {
        const existingSessionIssue = resumeIssueHintsBySession.get(entry.session_id);
        if (existingSessionIssue) {
          const createNew = window.confirm(
            `Session ${shortSessionId(entry.session_id)} is already linked to ${existingSessionIssue.identifier}.\n\nPress OK to create a NEW issue, or Cancel to reuse ${existingSessionIssue.identifier}.`,
          );
          if (!createNew) {
            effectiveIssueID = existingSessionIssue.id;
            toast.info(`Reusing ${existingSessionIssue.identifier}`);
          }
        }
      }

      if (!effectiveIssueID && entry.work_dir) {
        const existingWorkDirIssue = resumeIssueHintsByWorkDir.get(entry.work_dir);
        if (existingWorkDirIssue) {
          const createNew = window.confirm(
            `Found an existing resume issue for this workdir: ${existingWorkDirIssue.identifier}.\n\nPress OK to create a NEW issue, or Cancel to reuse ${existingWorkDirIssue.identifier}.`,
          );
          if (!createNew) {
            effectiveIssueID = existingWorkDirIssue.id;
            toast.info(`Reusing ${existingWorkDirIssue.identifier}`);
          }
        }
      }

      if (!effectiveIssueID) {
        const createdIssue = await api.createIssue({
          title: `Resume ${shortSessionId(entry.session_id)} - ${command}`,
          description: `Auto-created for resume flow.\n\nCommand: ${command}\nWorkdir: ${entry.work_dir || "(unknown)"}`,
          status: "todo",
          priority: "none",
          assignee_type: currentUser?.id ? "member" : undefined,
          assignee_id: currentUser?.id || undefined,
        });
        effectiveIssueID = createdIssue.id;
        toast.info(`Auto-created ${createdIssue.identifier} for this resume task.`);
      }

      try {
        await api.resumeAgentExternalSession(agent.id, {
          session_id: entry.session_id,
          work_dir: entry.work_dir,
          issue_id: effectiveIssueID,
        });
      } catch (resumeErr) {
        if (!isPendingTaskConflict(resumeErr)) {
          throw resumeErr;
        }

        const createNew = window.confirm(
          `Issue already has a pending task for this agent.\n\nPress OK to create a NEW issue for another continue run, or Cancel to stop.`,
        );
        if (!createNew) {
          throw resumeErr;
        }

        const createdIssue = await api.createIssue({
          title: `Resume ${shortSessionId(entry.session_id)} - ${command}`,
          description: `Auto-created for parallel resume run.\n\nCommand: ${command}\nWorkdir: ${entry.work_dir || "(unknown)"}`,
          status: "todo",
          priority: "none",
          assignee_type: currentUser?.id ? "member" : undefined,
          assignee_id: currentUser?.id || undefined,
        });
        effectiveIssueID = createdIssue.id;
        toast.info(`Created ${createdIssue.identifier} due to pending-task conflict.`);

        await api.resumeAgentExternalSession(agent.id, {
          session_id: entry.session_id,
          work_dir: entry.work_dir,
          issue_id: effectiveIssueID,
        });
      }
      toast.success("Resume task queued");
      await loadData({ background: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to queue resume task");
    } finally {
      inFlightResumeSessionsRef.current.delete(entry.session_id);
      setResumingSessionIds((prev) => {
        const next = { ...prev };
        delete next[entry.session_id];
        return next;
      });
    }
  };

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 rounded-lg border px-4 py-3">
            <Skeleton className="h-4 w-4 rounded shrink-0" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
            </div>
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold">Task Queue</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Issues assigned to this agent and their execution status.
        </p>
      </div>

      <div className="rounded-lg border p-3">
        <div className="mb-2 flex items-center justify-between">
          <div>
            <h4 className="text-sm font-semibold">Resume Sessions (7d)</h4>
            <p className="text-xs text-muted-foreground">
              Operate concrete resumable sessions, similar to codex resume list.
            </p>
          </div>
          <span className="text-xs text-muted-foreground">
            {resumeEntries.length} sessions
          </span>
        </div>

        {resumeEntries.length === 0 ? (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              No resumable sessions from the last 7 days.
            </p>
            <p className="text-[11px] text-muted-foreground">
              If sessions exist on host, mount host <code>~/.codex</code> into backend and set{" "}
              <code>MULTICA_CODEX_SESSIONS_ROOT</code>.
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {resumeEntries.map((entry) => {
              const issue = entry.issue_id ? issueMap.get(entry.issue_id) : undefined;
              const isResuming = !!resumingSessionIds[entry.session_id];
              return (
                <div
                  key={`resume-${entry.session_id}`}
                  className="flex items-center gap-3 rounded-md border px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                        {shortSessionId(entry.session_id)}
                      </span>
                      <span className="rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {entry.source}
                      </span>
                      {issue ? (
                        <span className="truncate text-xs text-muted-foreground">
                          {issue.identifier} - {issue.title}
                        </span>
                      ) : (
                        <span className="truncate text-xs text-muted-foreground">
                          No issue bound
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {entry.source === "task" ? "Completed" : "Last seen"}{" "}
                      {new Date(entry.timestamp).toLocaleString()}
                    </div>
                    {!entry.issue_id && !entry.source_task_id && (
                      <div className="mt-1.5 flex items-center gap-2">
                        <span className="text-[11px] text-muted-foreground">Bind issue:</span>
                        <select
                          className="h-7 min-w-[180px] rounded border bg-background px-2 text-xs"
                          value={issueBindingBySession[entry.session_id] ?? ""}
                          disabled={isResuming}
                          onChange={(e) =>
                            setIssueBindingBySession((prev) => ({
                              ...prev,
                              [entry.session_id]: e.target.value,
                            }))
                          }
                        >
                          <option value="">Tasks only (no issue)</option>
                          {bindableIssues.map((bindIssue) => (
                            <option key={bindIssue.id} value={bindIssue.id}>
                              {bindIssue.identifier} - {bindIssue.title}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => copySessionId(entry.session_id)}
                  >
                    <Copy className="h-3.5 w-3.5" />
                    Copy ID
                  </Button>
                  <Button size="sm" disabled={isResuming} onClick={() => handleResume(entry)}>
                    <RotateCcw className="h-3.5 w-3.5" />
                    {isResuming ? "Queueing..." : "Continue"}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {tasks.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-12">
          <ListTodo className="h-8 w-8 text-muted-foreground/40" />
          <p className="mt-3 text-sm text-muted-foreground">No tasks in queue</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Assign an issue to this agent to get started.
          </p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {sortedTasks.map((task) => {
            const config = taskStatusConfig[task.status] ?? taskStatusConfig.queued!;
            const Icon = config.icon;
            const issue = issueMap.get(task.issue_id);
            const isActive = task.status === "running" || task.status === "dispatched";
            const isRunning = task.status === "running";
            const resumeCommand = resolveTaskResumeCommand(task);
            const issueTitle = issue
              ? issue.title
              : task.issue_id
                ? `Issue ${task.issue_id.slice(0, 8)}...`
                : resumeCommand ?? "Manual resume session";

            return (
              <div
                key={task.id}
                className={`flex items-center gap-3 rounded-lg border px-4 py-3 ${
                  isRunning
                    ? "border-success/40 bg-success/5"
                    : task.status === "dispatched"
                      ? "border-info/40 bg-info/5"
                      : ""
                }`}
              >
                <Icon
                  className={`h-4 w-4 shrink-0 ${config.color} ${
                    isRunning ? "animate-spin" : ""
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {issue && (
                      <span className="shrink-0 text-xs font-mono text-muted-foreground">
                        {issue.identifier}
                      </span>
                    )}
                    <span className={`text-sm truncate ${isActive ? "font-medium" : ""}`}>
                      {issueTitle}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {isRunning && task.started_at
                      ? `Started ${new Date(task.started_at).toLocaleString()}`
                      : task.status === "dispatched" && task.dispatched_at
                        ? `Dispatched ${new Date(task.dispatched_at).toLocaleString()}`
                        : task.status === "completed" && task.completed_at
                          ? `Completed ${new Date(task.completed_at).toLocaleString()}`
                          : task.status === "failed" && task.completed_at
                            ? `Failed ${new Date(task.completed_at).toLocaleString()}`
                            : `Queued ${new Date(task.created_at).toLocaleString()}`}
                  </div>
                  {resumeCommand && (
                    <div className="mt-1">
                      <code
                        className="inline-block max-w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                        title={resumeCommand}
                      >
                        {resumeCommand}
                      </code>
                    </div>
                  )}
                </div>
                <span className={`shrink-0 text-xs font-medium ${config.color}`}>
                  {config.label}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
