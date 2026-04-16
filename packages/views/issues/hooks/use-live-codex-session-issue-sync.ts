"use client";

import { useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@multica/core/auth";
import { api } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { issueKeys, issueListOptions } from "@multica/core/issues/queries";
import { agentListOptions } from "@multica/core/workspace/queries";
import { toast } from "sonner";

const LIVE_SESSION_WINDOW_MS = 2 * 60 * 1000;
const SYNC_INTERVAL_MS = 30 * 1000;
const MAX_NEW_ISSUES_PER_SCAN = 3;

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

export function useLiveCodexSessionIssueSync() {
  const wsId = useWorkspaceId();
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const inFlightSessionIDsRef = useRef<Set<string>>(new Set());
  const knownCreatedSessionIDsRef = useRef<Set<string>>(new Set());
  const warnedRef = useRef(false);

  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const { data: allIssues = [] } = useQuery(issueListOptions(wsId));

  const knownSessionIDs = useMemo(() => {
    const set = new Set<string>();
    for (const issue of allIssues) {
      const sid = extractResumeSessionID(`${issue.title}\n${issue.description || ""}`);
      if (sid) set.add(sid);
    }
    return set;
  }, [allIssues]);

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

      const activeAgents = agents.filter((a) => !a.archived_at);
      if (activeAgents.length === 0) return;

      let createdCount = 0;
      const now = Date.now();

      for (const agent of activeAgents) {
        if (cancelled) return;
        if (createdCount >= MAX_NEW_ISSUES_PER_SCAN) break;

        let externalSessions: Awaited<ReturnType<typeof api.listAgentExternalSessions>> = [];
        try {
          externalSessions = await api.listAgentExternalSessions(agent.id, { days: 1 });
        } catch (err) {
          if (!warnedRef.current) {
            warnedRef.current = true;
            toast.error(err instanceof Error ? err.message : "Failed to scan live Codex sessions");
          }
          continue;
        }

        for (const session of externalSessions) {
          if (cancelled) return;
          if (createdCount >= MAX_NEW_ISSUES_PER_SCAN) break;

          const sid = session.session_id?.trim();
          if (!sid) continue;
          if (session.issue_id) {
            knownCreatedSessionIDsRef.current.add(sid);
            continue;
          }
          if (knownSessionIDs.has(sid) || knownCreatedSessionIDsRef.current.has(sid)) continue;
          if (inFlightSessionIDsRef.current.has(sid)) continue;

          const seenTs = Date.parse(session.last_seen_at);
          if (Number.isNaN(seenTs)) continue;
          if (now - seenTs > LIVE_SESSION_WINDOW_MS) continue;

          inFlightSessionIDsRef.current.add(sid);
          try {
            const command = `codex resume ${sid}`;
            await api.createIssue({
              title: `Live ${shortSessionId(sid)} - ${command}`,
              description:
                `Auto-created from active external Codex session detection.\n\n` +
                `Command: ${command}\n` +
                `Agent: ${agent.name}\n` +
                `Workdir: ${session.work_dir || "(unknown)"}`,
              status: "todo",
              priority: "none",
              assignee_type: user?.id ? "member" : "agent",
              assignee_id: user?.id || agent.id,
            });
            knownCreatedSessionIDsRef.current.add(sid);
            createdCount += 1;
          } catch {
            // Ignore per-session failures; continue scanning others.
          } finally {
            inFlightSessionIDsRef.current.delete(sid);
          }
        }
      }

      if (createdCount > 0 && !cancelled) {
        toast.info(`Synced ${createdCount} active Codex session(s) to issues.`);
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
  }, [agents, knownSessionIDs, qc, user?.id, wsId]);
}
