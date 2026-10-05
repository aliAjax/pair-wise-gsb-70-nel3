import {
  diffFingerprint,
  exemptionValidity,
  type ApiContract,
  type ContractChange,
  type Exemption,
  type ReleaseIssue,
} from './contract';
import { stableChecksum } from '../lib/utils';

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

/** 未升级且仍有生产流量的调用方（按 调用方 × 客户端版本 粒度） */
export interface AffectedCaller {
  callerId: string;
  callerName: string;
  /** 是否在契约登记的调用方清单中 */
  registered: boolean;
  clientVersion: string;
  requestsPerDay: number;
  capturedAt: string;
}

export interface ReconCandidate extends AffectedCaller {
  /** 无有效豁免的不兼容变化 */
  uncoveredChangeIds: string[];
  /** 已被有效豁免覆盖的不兼容变化 */
  coveredChangeIds: string[];
  status: 'blocked' | 'exempted';
}

export interface Reconciliation {
  contractId: string;
  /** 乐观并发令牌，每次写入递增 */
  revision: number;
  /** 兼容基线：客户端版本达到该版本视为已升级 */
  baselineClientVersion: string;
  /** 对账时不兼容差异的总指纹，差异变化后对账结果失效 */
  diffFingerprint: string;
  candidates: ReconCandidate[];
  sourceSnapshotCount: number;
  dedupedSnapshotCount: number;
  computedAt: string;
}

export type ReconStage = 'dedupe' | 'candidates' | 'evaluate' | 'persist';

export const RECON_STAGE_LABELS: Record<ReconStage, string> = {
  dedupe: '快照去重',
  candidates: '候选计算',
  evaluate: '豁免评估',
  persist: '结果写入',
};

/** 对账流水线检查点：写入失败后从最近阶段恢复，不必从头重算 */
export interface ReconCheckpoint {
  contractId: string;
  nextStage: ReconStage;
  baseRevision: number;
  baselineClientVersion: string;
  sourceSnapshotCount: number;
  deduped?: TrafficSnapshot[];
  affected?: AffectedCaller[];
  evaluated?: ReconCandidate[];
  savedAt: string;
}

export function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  if (leftParts.some(Number.isNaN) || rightParts.some(Number.isNaN)) {
    return left.localeCompare(right);
  }
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** 同一调用方同一客户端版本只认最新快照 */
export function dedupeSnapshots(snapshots: TrafficSnapshot[]): TrafficSnapshot[] {
  const latest = new Map<string, TrafficSnapshot>();
  for (const snapshot of snapshots) {
    const key = `${snapshot.contractId}::${snapshot.callerId}::${snapshot.clientVersion}`;
    const existing = latest.get(key);
    if (!existing || snapshot.capturedAt > existing.capturedAt) {
      latest.set(key, snapshot);
    }
  }
  return [...latest.values()].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
}

/** 当前工作副本全部不兼容差异的总指纹 */
export function contractDiffFingerprint(changes: ContractChange[]): string {
  return stableChecksum(
    changes
      .filter((change) => change.compatibility === 'breaking')
      .map((change) => diffFingerprint(change))
      .sort()
      .join('|'),
  );
}

/** 建议的兼容基线：已登记调用方最高客户端版本的下一个次版本 */
export function suggestBaseline(contract: ApiContract): string {
  if (!contract.consumers.length) return '0.0.0';
  const max = contract.consumers
    .map((consumer) => consumer.clientVersion)
    .reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
  const parts = max.split('.').map(Number);
  if (parts.length < 2 || parts.some(Number.isNaN)) return max;
  return `${parts[0]}.${parts[1] + 1}.0`;
}

/** 受影响候选：未升级（在跑版本低于基线）且有生产流量 */
export function findAffectedCallers(input: {
  contract: ApiContract;
  snapshots: TrafficSnapshot[];
  baselineClientVersion: string;
}): AffectedCaller[] {
  const registered = new Map(
    input.contract.consumers.map((consumer) => [consumer.id, consumer.name]),
  );
  return input.snapshots
    .filter((snapshot) => snapshot.contractId === input.contract.id)
    .filter((snapshot) => snapshot.environment === '生产' && snapshot.requestsPerDay > 0)
    .filter(
      (snapshot) => compareVersions(snapshot.clientVersion, input.baselineClientVersion) < 0,
    )
    .map((snapshot) => ({
      callerId: snapshot.callerId,
      callerName: snapshot.callerName || registered.get(snapshot.callerId) || snapshot.callerId,
      registered: registered.has(snapshot.callerId),
      clientVersion: snapshot.clientVersion,
      requestsPerDay: snapshot.requestsPerDay,
      capturedAt: snapshot.capturedAt,
    }))
    .sort((a, b) => b.requestsPerDay - a.requestsPerDay);
}

/** 豁免评估：过期或差异变化的豁免不计入，逐调用方判定覆盖情况 */
export function evaluateCandidates(input: {
  affected: AffectedCaller[];
  breakingChanges: ContractChange[];
  exemptions: Exemption[];
  now?: Date;
}): ReconCandidate[] {
  const now = input.now ?? new Date();
  return input.affected.map((caller) => {
    const uncoveredChangeIds: string[] = [];
    const coveredChangeIds: string[] = [];
    for (const change of input.breakingChanges) {
      const covered = input.exemptions.some(
        (exemption) =>
          exemption.changeId === change.id &&
          (!exemption.callerId || exemption.callerId === caller.callerId) &&
          exemptionValidity(exemption, change, now) === 'valid',
      );
      (covered ? coveredChangeIds : uncoveredChangeIds).push(change.id);
    }
    return {
      ...caller,
      uncoveredChangeIds,
      coveredChangeIds,
      status: uncoveredChangeIds.length ? ('blocked' as const) : ('exempted' as const),
    };
  });
}

/**
 * 上线对账门禁：存在不兼容变化时必须先完成针对当前差异的对账；
 * 只有未升级且有生产流量、又无有效豁免的调用方才挡住发布。
 */
export function reconciliationGateIssues(
  contract: ApiContract,
  reconciliation: Reconciliation | undefined,
): ReleaseIssue[] {
  const breaking = contract.changes.filter((change) => change.compatibility === 'breaking');
  if (!breaking.length) return [];
  if (!reconciliation) {
    return [
      {
        id: 'recon-missing',
        severity: 'blocker',
        title: '未完成上线对账',
        detail: '存在不兼容变化，发布前需要基于网关流量快照核对调用方实际在跑版本。',
      },
    ];
  }
  const issues: ReleaseIssue[] = [];
  if (reconciliation.diffFingerprint !== contractDiffFingerprint(contract.changes)) {
    issues.push({
      id: 'recon-stale',
      severity: 'blocker',
      title: '对账结果已失效',
      detail: '不兼容差异在对账后发生变化，受影响候选与豁免需重新核对。',
    });
  }
  for (const candidate of reconciliation.candidates) {
    if (candidate.status !== 'blocked') continue;
    issues.push({
      id: `recon-${candidate.callerId}-${candidate.clientVersion}`,
      severity: 'blocker',
      title: '调用方未升级且未豁免',
      detail: `${candidate.callerName} 仍以 ${candidate.clientVersion} 在生产运行（日均 ${candidate.requestsPerDay.toLocaleString('zh-CN')} 次），${candidate.uncoveredChangeIds.length} 项不兼容变化无有效豁免。`,
    });
  }
  return issues;
}
