"use client";

import { useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@multica/core/auth";
import { api } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { issueKeys, issueListOptions } from "@multica/core/issues/queries";
import { agentListOptions } from "@multica/core/workspace/queries";
import type { AgentTask } from "@multica/core/types";
import { toast } from "sonner";

const LIVE_SESSION_WINDOW_MS = 6 * 60 * 60 * 1000;
const SYNC_INTERVAL_MS = 30 * 1000;
const MAX_NEW_ISSUES_PER_SCAN = 3;

type SessionCandidate = {
  sessionId: string;
  workDir?: string;
  agentId: string;
  agentName: string;
  source: "task" | "external";
  sourceTaskId?: string;
  seenAt?: string;
};

function shortSessionId(sessionId: string): string {
  if (sessionId.length <= 20) return sessionId;
  return `${sessionId.slice(0, 8)}...${sessionId.slice(-8)}`;
}

function extractResumeSessionID(text: string): string {
  const match = text.match(
    /codex resume ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  return match?.[1]?.trim() || "";
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

function isAlreadyBoundConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const maybeError = error as { status?: number; message?: string };
  if (maybeError.status !== 409) return false;
  const msg = (maybeError.message || "").toLowerCase();
  return msg.includes("already bound") || msg.includes("cannot be bound");
}

export function useLiveCodexSessionIssueSync() {
  const wsId = useWorkspaceId();
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const inFlightSessionIDsRef = useRef<Set<string>>(new Set());
  const knownCreatedSessionIDsRef = useRef<Set<string>>(new Set());
  const warnedRef = useRef(false);

  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const { data: allIssues = [] } = useQuery(issueListOptions(wsId));

  const knownSessionIssueMap = useMemo(() => {
    const bySession = new Map<string, string>();
    for (const issue of allIssues) {
      const sid = extractResumeSessionID(`${issue.title}\n${issue.description || ""}`);
      if (sid) bySession.set(sid, issue.id);
    }
    return bySession;
  }, [allIssues]);

  const knownSessionIDs = useMemo(() => {
    return Array.from(knownSessionIssueMap.keys());
  }, [knownSessionIssueMap]);

  useEffect(() => {
    for (const sid of knownSessionIDs) {
      knownCreatedSessionIDsRef.current.add(sid);
    }
  }, [knownSessionIDs]);

  useEffect(() => {
    let cancelled = false;

    const syncLiveSessions = async () => {
      if (cancelled) return;
      if (agents.length === 0) return;
      if (!user?.id) return;

      const activeAgents = agents.filter((a) => !a.archived_at);
      if (activeAgents.length === 0) return;

      let createdCount = 0;
      let boundCount = 0;
      const now = Date.now();

      for (const agent of activeAgents) {
        if (cancelled) return;
        if (createdCount >= MAX_NEW_ISSUES_PER_SCAN) break;

        let externalSessions: Awaited<ReturnType<typeof api.listAgentExternalSessions>> = [];
        let tasks: AgentTask[] = [];
        try {
          [externalSessions, tasks] = await Promise.all([
            api.listAgentExternalSessions(agent.id, { days: 7 }),
            api.listAgentTasks(agent.id),
          ]);
        } catch (err) {
          if (!warnedRef.current) {
            warnedRef.current = true;
            toast.error(err instanceof Error ? err.message : "Failed to scan live Codex tasks/sessions");
          }
          continue;
        }

        const candidatesBySession = new Map<string, SessionCandidate>();

        for (const session of externalSessions) {
          const sid = session.session_id?.trim();
          if (!sid) continue;
          if (session.issue_id) {
            knownCreatedSessionIDsRef.current.add(sid);
            continue;
          }
          candidatesBySession.set(sid, {
            sessionId: sid,
            workDir: session.work_dir,
            agentId: agent.id,
            agentName: agent.name,
            source: "external",
            seenAt: session.last_seen_at,
          });
        }

        for (const task of tasks) {
          if (!isActiveTaskStatus(task.status)) continue;
          const sid = resolveTaskResumeSessionId(task);
          if (!sid) continue;
          if (task.issue_id) {
            knownCreatedSessionIDsRef.current.add(sid);
            continue;
          }
          const current = candidatesBySession.get(sid);
          if (!current || current.source !== "task") {
            candidatesBySession.set(sid, {
              sessionId: sid,
              workDir: task.work_dir || current?.workDir,
              agentId: agent.id,
              agentName: agent.name,
              source: "task",
              sourceTaskId: task.id,
            });
          }
        }

        for (const candidate of candidatesBySession.values()) {
          if (cancelled) return;
          if (createdCount >= MAX_NEW_ISSUES_PER_SCAN) break;

          const sid = candidate.sessionId.trim();
          if (!sid) continue;
          const knownIssueID = knownSessionIssueMap.get(sid) || "";
          const alreadyHandled = knownCreatedSessionIDsRef.current.has(sid);
          if (!candidate.sourceTaskId && alreadyHandled) continue;
          if (candidate.sourceTaskId && alreadyHandled && !knownIssueID) continue;
          if (inFlightSessionIDsRef.current.has(sid)) continue;

          if (candidate.source === "external" && candidate.seenAt) {
            const seenTs = Date.parse(candidate.seenAt);
            if (Number.isNaN(seenTs)) continue;
            if (now - seenTs > LIVE_SESSION_WINDOW_MS) continue;
          }

          inFlightSessionIDsRef.current.add(sid);
          try {
            let issueId = knownIssueID;
            const command = `codex resume ${sid}`;

            if (!issueId) {
              const created = await api.createIssue({
                title: `Live ${shortSessionId(sid)} - ${command}`,
                description:
                  `Auto-created from active Codex session detection.\n\n` +
                  `Command: ${command}\n` +
                  `Agent: ${candidate.agentName}\n` +
                  `Workdir: ${candidate.workDir || "(unknown)"}`,
                status: "todo",
                priority: "none",
                assignee_type: "member",
                assignee_id: user.id,
              });
              issueId = created.id;
              createdCount += 1;
            }

            if (candidate.sourceTaskId && issueId) {
              try {
                await api.bindAgentTaskIssue(candidate.agentId, candidate.sourceTaskId, issueId);
                boundCount += 1;
              } catch (bindErr) {
                if (!isAlreadyBoundConflict(bindErr)) {
                  throw bindErr;
                }
              }
            }

            knownCreatedSessionIDsRef.current.add(sid);
          } catch {
            // Ignore per-session failures; continue scanning others.
          } finally {
            inFlightSessionIDsRef.current.delete(sid);
          }
        }
      }

      if ((createdCount > 0 || boundCount > 0) && !cancelled) {
        if (createdCount > 0) {
          toast.info(`Synced ${createdCount} active Codex session(s) to issues.`);
        }
        await Promise.all([
          qc.invalidateQueries({ queryKey: issueKeys.all(wsId) }),
          qc.invalidateQueries({ queryKey: issueKeys.myAll(wsId) }),
        ]);
      }
    };

    void syncLiveSessions();
    const timer = window.setInterval(() => {
      void syncLiveSessions();
    }, SYNC_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [agents, knownSessionIDs, knownSessionIssueMap, qc, user?.id, wsId]);
}
