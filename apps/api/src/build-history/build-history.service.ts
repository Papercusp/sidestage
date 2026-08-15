import { Injectable } from '@nestjs/common';
import { BUILD_HISTORY_SNAPSHOT } from './build-history.snapshot';

export interface BuildHistoryCommit {
  sha: string;
  url: string | null;
  subject: string | null;
  committedAt: string | null;
  files: string[];
  remoteStatus: 'confirmed' | 'local-only' | 'unknown';
  attribution: 'authoritative' | 'body-reference' | 'inferred';
}

export interface BuildHistoryWorkItem {
  id: string;
  kind: string;
  title: string;
  state: string;
  completedAt: string | null;
  completionAuthority: string | null;
  completionSummary: string | null;
  completionEvidence: Record<string, unknown> | null;
  commits: BuildHistoryCommit[];
}

export interface BuildHistoryRepository {
  provider: 'github' | 'git';
  url: string;
  webUrl: string | null;
  defaultBranch?: string | null;
}

export interface BuildHistoryProject {
  id: string;
  name: string;
  repository: BuildHistoryRepository | null;
}

export interface BuildHistoryPlanItem {
  id: string;
  text: string;
  storedStatus: string;
  effectiveStatus: string;
  importance: string | null;
  riskTier: string | null;
  authority: string | null;
  blockedBy: string[];
  phase: string | null;
  lineNumber: number;
}

export interface BuildHistoryDecision {
  id: string;
  title: string;
  body: string;
  date: string | null;
  itemRefs: string[];
  lineNumber: number;
}

export interface BuildHistorySnapshotSource {
  kind: 'papercusp-plan-export';
  workspace: string;
  harness: string;
  planPrefix: string | null;
  generatedAt: string;
  planCount: number;
  generator: string;
}

export interface BuildHistoryPlan {
  slug: string;
  title: string;
  status: string;
  updatedAt: string | null;
  contentHash: string;
  markdown: string;
  frontmatter: Record<string, unknown>;
  items: BuildHistoryPlanItem[];
  decisions: BuildHistoryDecision[];
  completedItems: BuildHistoryWorkItem[];
  project: BuildHistoryProject;
  snapshot: BuildHistorySnapshotSource;
}

/**
 * History is a committed projection, not a runtime federation call. Keeping
 * the Papercusp export step explicit makes the public API deterministic even
 * when the operator, its Postgres store, or the private tool plane is absent.
 */
export function loadBuildHistorySnapshot(): BuildHistoryPlan[] {
  const snapshot = { ...BUILD_HISTORY_SNAPSHOT.source } as BuildHistorySnapshotSource;
  const project = {
    ...BUILD_HISTORY_SNAPSHOT.project,
    repository: BUILD_HISTORY_SNAPSHOT.project.repository
      ? { ...BUILD_HISTORY_SNAPSHOT.project.repository }
      : null,
  } as BuildHistoryProject;
  return BUILD_HISTORY_SNAPSHOT.plans.map((plan) => ({
    ...(plan as unknown as Omit<BuildHistoryPlan, 'project' | 'snapshot'>),
    project,
    snapshot,
  }));
}

@Injectable()
export class BuildHistoryService {
  list(): BuildHistoryPlan[] {
    return loadBuildHistorySnapshot();
  }
}
