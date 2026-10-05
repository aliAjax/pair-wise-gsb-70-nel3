import {
  evaluateExemption,
  type ApiContract,
  type ContractChange,
  type Exemption,
  type ReleaseIssue,
} from './contract';

/** 网关上报的调用方流量快照 */
export interface TrafficSnapshot {
  id: string;
  contractId: string;
  callerId: string;
  callerName: string;
  clientVersion: string;
  environment: '生产' | '预发' | '灰度';
  requestsPerDay: number;
  capturedAt: string;
}

export type CandidateStatus =
  | 'blocked'
  | 'exempted'
  | 'upgraded'
  | 'no-production-traffic'
  | 'no-snapshot';

export interface ReconciliationCandidate {
  id: string;
  callerId: string;
  callerName: string;
  registered: boolean;
  registryVersion: string;
  changeId: string;
  changeLabel: string;
  status: CandidateStatus;
  laggingVersions: Array<{ clientVersion: string; requestsPerDay: number; capturedAt: string }>;
  exemptionId?: string;
  reason: string;
}

export interface ReconciliationRun {
  id: string;
  contractId: string;
  targetVersion: string;
  computedAt: string;
  snapshotWatermark: string;
  status: 'clear' | 'blocked';
  candidates: ReconciliationCandidate[];
}

export interface ReconciliationStore {
  revision: number;
  snapshots: TrafficSnapshot[];
  runs: ReconciliationRun[];
}

export const CANDIDATE_STATUS_LABELS: Record<CandidateStatus, string> = {
  blocked: '阻挡发布',
  exempted: '豁免放行',
  upgraded: '已升级',
  'no-production-traffic': '无生产流量',
  'no-snapshot': '缺少快照',
};

const STATUS_ORDER: Record<CandidateStatus, number> = {
  blocked: 0,
  exempted: 1,
  'no-snapshot': 2,
  'no-production-traffic': 3,
  upgraded: 4,
};

/** 同一调用方同一版本只认最新快照；采集时间相同时后到的覆盖先到的 */
export function dedupeSnapshots(snapshots: TrafficSnapshot[]): TrafficSnapshot[] {
  const latest = new Map<string, TrafficSnapshot>();
  for (const snapshot of snapshots) {
    const key = `${snapshot.contractId}|${snapshot.callerId}|${snapshot.clientVersion}`;
    const existing = latest.get(key);
    if (!existing || snapshot.capturedAt >= existing.capturedAt) {
      latest.set(key, snapshot);
    }
  }
  return [...latest.values()].sort((left, right) =>
    `${left.callerId}|${left.clientVersion}`.localeCompare(`${right.callerId}|${right.clientVersion}`),
  );
}

export function compareVersions(left: string, right: string): number {
  const a = left.split('.');
  const b = right.split('.');
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const partA = a[index] ?? '0';
    const partB = b[index] ?? '0';
    const numA = Number(partA);
    const numB = Number(partB);
    if (Number.isNaN(numA) || Number.isNaN(numB)) {
      const text = partA.localeCompare(partB);
      if (text !== 0) return text;
      continue;
    }
    if (numA !== numB) return numA - numB;
  }
  return 0;
}

function snapshotWatermark(snapshots: TrafficSnapshot[], contractId: string): string {
  let watermark = '';
  for (const snapshot of snapshots) {
    if (snapshot.contractId === contractId && snapshot.capturedAt > watermark) {
      watermark = snapshot.capturedAt;
    }
  }
  return watermark;
}

function pickExemption(
  exemptions: Exemption[],
  change: ContractChange,
  now: Date,
): { exemption: Exemption; valid: boolean; reason: string } | undefined {
  const matches = exemptions.filter((item) => item.changeId === change.id);
  if (!matches.length) return undefined;
  const evaluated = matches.map((exemption) => ({
    exemption,
    ...evaluateExemption(exemption, change, now),
  }));
  return evaluated.find((item) => item.valid) ?? evaluated[0];
}

function buildCandidate(
  contract: ApiContract,
  callerId: string,
  callerSnapshots: TrafficSnapshot[],
  change: ContractChange,
  now: Date,
): ReconciliationCandidate {
  const consumer = contract.consumers.find((item) => item.id === callerId);
  const callerName = consumer?.name ?? callerSnapshots[0]?.callerName ?? callerId;
  const production = callerSnapshots.filter(
    (snapshot) => snapshot.environment === '生产' && snapshot.requestsPerDay > 0,
  );
  // 未登记调用方无法证明已升级，任何生产版本都按滞后处理
  const lagging = consumer
    ? production.filter(
        (snapshot) => compareVersions(snapshot.clientVersion, consumer.clientVersion) < 0,
      )
    : production;
  const base = {
    id: `${callerId}:${change.id}`,
    callerId,
    callerName,
    registered: Boolean(consumer),
    registryVersion: consumer?.clientVersion ?? '',
    changeId: change.id,
    changeLabel: `${change.method} ${change.path}`,
    laggingVersions: lagging.map((snapshot) => ({
      clientVersion: snapshot.clientVersion,
      requestsPerDay: snapshot.requestsPerDay,
      capturedAt: snapshot.capturedAt,
    })),
  };

  if (!callerSnapshots.length) {
    return {
      ...base,
      status: 'no-snapshot',
      reason: '登记在册但网关没有快照，无法完成对账。',
    };
  }
  if (!lagging.length) {
    return production.length
      ? {
          ...base,
          status: 'upgraded',
          reason: consumer
            ? `网关生产版本不低于登记版本 ${consumer.clientVersion}。`
            : '网关在跑版本无需处理。',
        }
      : {
          ...base,
          status: 'no-production-traffic',
          reason: '网关无生产流量，不兼容变化不影响该调用方。',
        };
  }

  const exemption = pickExemption(contract.exemptions, change, now);
  if (exemption?.valid) {
    return {
      ...base,
      status: 'exempted',
      exemptionId: exemption.exemption.id,
      reason: `兼容层豁免有效（${exemption.reason}）`,
    };
  }
  return {
    ...base,
    status: 'blocked',
    exemptionId: exemption?.exemption.id,
    reason: exemption
      ? `豁免失效：${exemption.reason}`
      : '未升级且仍有生产流量，没有有效豁免。',
  };
}

/**
 * 计算对账候选。onlyCallerIds 用于快照更新后的增量重算：
 * 只重算受影响调用方的候选，其余候选保持不变。
 */
export function computeCandidates(
  contract: ApiContract,
  snapshots: TrafficSnapshot[],
  now: Date,
  onlyCallerIds?: Set<string>,
): ReconciliationCandidate[] {
  const breakingChanges = contract.changes.filter((change) => change.compatibility === 'breaking');
  if (!breakingChanges.length) return [];
  const latest = dedupeSnapshots(snapshots).filter(
    (snapshot) => snapshot.contractId === contract.id,
  );
  const callerIds = new Set<string>([
    ...contract.consumers.map((consumer) => consumer.id),
    ...latest.map((snapshot) => snapshot.callerId),
  ]);
  const targets = onlyCallerIds
    ? [...callerIds].filter((callerId) => onlyCallerIds.has(callerId))
    : [...callerIds];
  const candidates: ReconciliationCandidate[] = [];
  for (const callerId of targets) {
    const callerSnapshots = latest.filter((snapshot) => snapshot.callerId === callerId);
    for (const change of breakingChanges) {
      candidates.push(buildCandidate(contract, callerId, callerSnapshots, change, now));
    }
  }
  return sortCandidates(candidates);
}

function sortCandidates(candidates: ReconciliationCandidate[]): ReconciliationCandidate[] {
  return [...candidates].sort(
    (left, right) =>
      STATUS_ORDER[left.status] - STATUS_ORDER[right.status] ||
      left.callerName.localeCompare(right.callerName) ||
      left.changeId.localeCompare(right.changeId),
  );
}

function finalizeRun(
  run: Omit<ReconciliationRun, 'status' | 'snapshotWatermark'>,
  snapshots: TrafficSnapshot[],
): ReconciliationRun {
  return {
    ...run,
    snapshotWatermark: snapshotWatermark(snapshots, run.contractId),
    status: run.candidates.some((candidate) => candidate.status === 'blocked')
      ? 'blocked'
      : 'clear',
  };
}

export function computeReconciliation(
  contract: ApiContract,
  snapshots: TrafficSnapshot[],
  now: Date,
): ReconciliationRun {
  const candidates = computeCandidates(contract, snapshots, now);
  return finalizeRun(
    {
      id: `run-${contract.id}-${now.getTime()}`,
      contractId: contract.id,
      targetVersion: contract.version,
      computedAt: now.toISOString(),
      candidates,
    },
    snapshots,
  );
}

/** 快照更新后只重算受影响调用方的候选，合并回既有对账结果 */
export function recomputeAffectedCandidates(
  run: ReconciliationRun,
  contract: ApiContract,
  snapshots: TrafficSnapshot[],
  affectedCallerIds: string[],
  now: Date,
): { run: ReconciliationRun; recomputed: number } {
  const affected = new Set(affectedCallerIds);
  const fresh = computeCandidates(contract, snapshots, now, affected);
  const kept = run.candidates.filter((candidate) => !affected.has(candidate.callerId));
  const next = finalizeRun(
    {
      ...run,
      computedAt: now.toISOString(),
      targetVersion: contract.version,
      candidates: sortCandidates([...kept, ...fresh]),
    },
    snapshots,
  );
  return { run: next, recomputed: fresh.length };
}

export function summarizeCandidates(
  candidates: ReconciliationCandidate[],
): Record<CandidateStatus, number> {
  const summary: Record<CandidateStatus, number> = {
    blocked: 0,
    exempted: 0,
    upgraded: 0,
    'no-production-traffic': 0,
    'no-snapshot': 0,
  };
  for (const candidate of candidates) {
    summary[candidate.status] += 1;
  }
  return summary;
}

/** 发布门禁视角的对账结论：未升级且有生产流量的调用方才会阻断 */
export function buildReconciliationIssues(
  contract: ApiContract,
  snapshots: TrafficSnapshot[],
  now: Date = new Date(),
): ReleaseIssue[] {
  const issues: ReleaseIssue[] = [];
  for (const candidate of computeCandidates(contract, snapshots, now)) {
    if (candidate.status === 'blocked') {
      const versions = candidate.laggingVersions
        .map((item) => `v${item.clientVersion}（日均 ${item.requestsPerDay.toLocaleString('zh-CN')} 次）`)
        .join('、');
      issues.push({
        id: `recon-${candidate.id}`,
        severity: 'blocker',
        title: '上线对账：调用方未升级且有生产流量',
        detail: `${candidate.callerName} 在网关仍运行 ${versions}，${candidate.changeLabel} 的不兼容变化会直接影响。${candidate.reason}`,
        changeId: candidate.changeId,
      });
    }
    if (candidate.status === 'no-snapshot') {
      issues.push({
        id: `recon-${candidate.id}`,
        severity: 'warning',
        title: '上线对账：登记调用方缺少网关快照',
        detail: `${candidate.callerName} 未出现在网关流量快照中，无法确认其客户端版本。`,
        changeId: candidate.changeId,
      });
    }
  }
  return issues;
}
