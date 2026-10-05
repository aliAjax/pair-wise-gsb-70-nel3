import { seedTrafficSnapshots } from '../data/seed';
import { diffFingerprint, type ApiContract, type Exemption } from '../models/contract';
import {
  contractDiffFingerprint,
  dedupeSnapshots,
  evaluateCandidates,
  findAffectedCallers,
  suggestBaseline,
  type AffectedCaller,
  type ReconCandidate,
  type ReconCheckpoint,
  type Reconciliation,
  type TrafficSnapshot,
} from '../models/reconciliation';
import { getContract, listContracts, saveContract } from './contract-service';

const SNAPSHOT_KEY = 'pair-wise-gsb-70-traffic-snapshots';
const RECON_KEY = 'pair-wise-gsb-70-reconciliations';
const CHECKPOINT_KEY = 'pair-wise-gsb-70-recon-checkpoints';
const LATENCY = 160;

/** 并发提交冲突：后到者看到版本已变化 */
export class RevisionConflictError extends Error {
  readonly expected: number;
  readonly current: number;

  constructor(expected: number, current: number) {
    super(`对账版本冲突：本次提交基于 rev ${expected}，当前最新已是 rev ${current}`);
    this.name = 'RevisionConflictError';
    this.expected = expected;
    this.current = current;
  }
}

/** 对账结果写入失败：检查点已保留，可恢复 */
export class ReconPersistError extends Error {
  constructor(message = '对账结果写入失败') {
    super(message);
    this.name = 'ReconPersistError';
  }
}

let failNextPersist = false;

/** 演练钩子：让下一次对账写入失败，用于验证检查点恢复 */
export function armPersistFailureDrill(): void {
  failNextPersist = true;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function wait(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, LATENCY));
}

async function requireContract(contractId: string): Promise<ApiContract> {
  const contract = await getContract(contractId);
  if (!contract) throw new Error('契约不存在');
  return contract;
}

function readSnapshots(): TrafficSnapshot[] {
  const stored = localStorage.getItem(SNAPSHOT_KEY);
  if (stored) {
    try {
      return JSON.parse(stored) as TrafficSnapshot[];
    } catch {
      localStorage.removeItem(SNAPSHOT_KEY);
    }
  }
  localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(seedTrafficSnapshots));
  return clone(seedTrafficSnapshots);
}

function writeSnapshots(snapshots: TrafficSnapshot[]): void {
  localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshots));
}

function readReconciliations(): Record<string, Reconciliation> {
  const stored = localStorage.getItem(RECON_KEY);
  if (!stored) return {};
  try {
    return JSON.parse(stored) as Record<string, Reconciliation>;
  } catch {
    localStorage.removeItem(RECON_KEY);
    return {};
  }
}

function writeReconciliations(records: Record<string, Reconciliation>): void {
  localStorage.setItem(RECON_KEY, JSON.stringify(records));
}

function readCheckpoints(): Record<string, ReconCheckpoint> {
  const stored = localStorage.getItem(CHECKPOINT_KEY);
  if (!stored) return {};
  try {
    return JSON.parse(stored) as Record<string, ReconCheckpoint>;
  } catch {
    localStorage.removeItem(CHECKPOINT_KEY);
    return {};
  }
}

function saveCheckpoint(checkpoint: ReconCheckpoint): void {
  const all = readCheckpoints();
  const previous = all[checkpoint.contractId];
  all[checkpoint.contractId] = { ...previous, ...checkpoint };
  localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(all));
}

function clearCheckpoint(contractId: string): void {
  const all = readCheckpoints();
  delete all[contractId];
  localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(all));
}

export async function getTrafficSnapshots(
  contractId: string,
): Promise<{ rawCount: number; snapshots: TrafficSnapshot[] }> {
  await wait();
  const scoped = readSnapshots().filter((snapshot) => snapshot.contractId === contractId);
  return { rawCount: scoped.length, snapshots: dedupeSnapshots(scoped) };
}

export async function getReconciliation(contractId: string): Promise<Reconciliation | undefined> {
  await wait();
  return readReconciliations()[contractId];
}

export async function getReconCheckpoint(
  contractId: string,
): Promise<ReconCheckpoint | undefined> {
  await wait();
  return readCheckpoints()[contractId];
}

/**
 * 执行上线对账：快照去重 → 候选计算 → 豁免评估 → 写入。
 * 每个阶段完成后落检查点，写入失败可从检查点恢复。
 */
export async function runReconciliation(
  contractId: string,
  options: { baselineClientVersion?: string } = {},
): Promise<Reconciliation> {
  const contract = await requireContract(contractId);
  const stored = readReconciliations()[contractId];
  const baseline =
    options.baselineClientVersion ?? stored?.baselineClientVersion ?? suggestBaseline(contract);
  const baseRevision = stored?.revision ?? 0;
  const snapshots = readSnapshots().filter((snapshot) => snapshot.contractId === contractId);

  // 阶段 1：同一调用方同一版本只认最新快照
  const deduped = dedupeSnapshots(snapshots);
  saveCheckpoint({
    contractId,
    nextStage: 'candidates',
    baseRevision,
    baselineClientVersion: baseline,
    sourceSnapshotCount: snapshots.length,
    deduped,
    savedAt: new Date().toISOString(),
  });
  await wait();

  return continueFromCandidates(contract, baseline, baseRevision, snapshots.length, deduped);
}

/** 从检查点恢复：只重跑尚未完成的阶段 */
export async function resumeReconciliation(contractId: string): Promise<Reconciliation> {
  const checkpoint = readCheckpoints()[contractId];
  if (!checkpoint) throw new Error('没有可恢复的检查点');
  const contract = await requireContract(contractId);
  const { baselineClientVersion, baseRevision, sourceSnapshotCount } = checkpoint;

  switch (checkpoint.nextStage) {
    case 'candidates':
      return continueFromCandidates(
        contract,
        baselineClientVersion,
        baseRevision,
        sourceSnapshotCount,
        checkpoint.deduped ?? [],
      );
    case 'evaluate':
      return continueFromEvaluate(
        contract,
        baselineClientVersion,
        baseRevision,
        sourceSnapshotCount,
        checkpoint.deduped?.length ?? 0,
        checkpoint.affected ?? [],
      );
    case 'persist':
      return persistReconciliation(
        contract,
        baselineClientVersion,
        baseRevision,
        sourceSnapshotCount,
        checkpoint.deduped?.length ?? 0,
        checkpoint.evaluated ?? [],
      );
    case 'dedupe':
      return runReconciliation(contractId, { baselineClientVersion });
  }
}

async function continueFromCandidates(
  contract: ApiContract,
  baseline: string,
  baseRevision: number,
  sourceSnapshotCount: number,
  deduped: TrafficSnapshot[],
): Promise<Reconciliation> {
  // 阶段 2：未升级且有生产流量的调用方才进入候选
  const affected = findAffectedCallers({
    contract,
    snapshots: deduped,
    baselineClientVersion: baseline,
  });
  saveCheckpoint({
    contractId: contract.id,
    nextStage: 'evaluate',
    baseRevision,
    baselineClientVersion: baseline,
    sourceSnapshotCount,
    deduped,
    affected,
    savedAt: new Date().toISOString(),
  });
  await wait();
  return continueFromEvaluate(
    contract,
    baseline,
    baseRevision,
    sourceSnapshotCount,
    deduped.length,
    affected,
  );
}

async function continueFromEvaluate(
  contract: ApiContract,
  baseline: string,
  baseRevision: number,
  sourceSnapshotCount: number,
  dedupedCount: number,
  affected: AffectedCaller[],
): Promise<Reconciliation> {
  // 阶段 3：豁免评估，过期或差异变化的豁免不计入
  const breaking = contract.changes.filter((change) => change.compatibility === 'breaking');
  const evaluated = breaking.length
    ? evaluateCandidates({ affected, breakingChanges: breaking, exemptions: contract.exemptions })
    : [];
  saveCheckpoint({
    contractId: contract.id,
    nextStage: 'persist',
    baseRevision,
    baselineClientVersion: baseline,
    sourceSnapshotCount,
    affected,
    evaluated,
    savedAt: new Date().toISOString(),
  });
  await wait();
  return persistReconciliation(
    contract,
    baseline,
    baseRevision,
    sourceSnapshotCount,
    dedupedCount,
    evaluated,
  );
}

async function persistReconciliation(
  contract: ApiContract,
  baseline: string,
  baseRevision: number,
  sourceSnapshotCount: number,
  dedupedCount: number,
  evaluated: ReconCandidate[],
): Promise<Reconciliation> {
  // 阶段 4：乐观并发写入，两个窗口同时提交时后到者看到版本变化
  await wait();
  if (failNextPersist) {
    failNextPersist = false;
    throw new ReconPersistError('对账结果写入失败（演练），检查点已保留');
  }
  const all = readReconciliations();
  const currentRevision = all[contract.id]?.revision ?? 0;
  if (currentRevision !== baseRevision) {
    // 检查点基于旧版本，恢复已无意义，需要重新对账
    clearCheckpoint(contract.id);
    throw new RevisionConflictError(baseRevision, currentRevision);
  }
  const reconciliation: Reconciliation = {
    contractId: contract.id,
    revision: currentRevision + 1,
    baselineClientVersion: baseline,
    diffFingerprint: contractDiffFingerprint(contract.changes),
    candidates: evaluated,
    sourceSnapshotCount,
    dedupedSnapshotCount: dedupedCount,
    computedAt: new Date().toISOString(),
  };
  writeReconciliations({ ...all, [contract.id]: reconciliation });
  clearCheckpoint(contract.id);
  return clone(reconciliation);
}

/** 接收一批网关流量快照：合并去重后自动重算受影响候选 */
export async function ingestTrafficSnapshots(
  contractId: string,
  batch: TrafficSnapshot[],
): Promise<Reconciliation> {
  await wait();
  const merged = dedupeSnapshots([...readSnapshots(), ...batch]);
  writeSnapshots(merged);
  return runReconciliation(contractId);
}

/** 模拟网关周期性上报：已登记调用方 + 网关仍在看到的未登记调用方 */
export async function ingestGatewaySnapshot(contractId: string): Promise<Reconciliation> {
  const contract = await requireContract(contractId);
  const existing = readSnapshots();
  const known = new Set(contract.consumers.map((consumer) => consumer.id));
  const capturedAt = new Date().toISOString();
  const jitter = (value: number) => Math.max(0, Math.round(value * (0.95 + Math.random() * 0.1)));

  const registeredBatch: TrafficSnapshot[] = contract.consumers.map((consumer, index) => ({
    id: `snap-${Date.now()}-r${index}`,
    contractId,
    callerId: consumer.id,
    callerName: consumer.name,
    clientVersion: consumer.clientVersion,
    environment: consumer.environment,
    requestsPerDay: jitter(consumer.requestsPerDay),
    capturedAt,
  }));
  const phantomBatch: TrafficSnapshot[] = dedupeSnapshots(existing)
    .filter(
      (snapshot) =>
        snapshot.contractId === contractId &&
        !known.has(snapshot.callerId) &&
        snapshot.requestsPerDay > 0,
    )
    .map((snapshot, index) => ({
      ...snapshot,
      id: `snap-${Date.now()}-p${index}`,
      requestsPerDay: jitter(snapshot.requestsPerDay),
      capturedAt,
    }));

  return ingestTrafficSnapshots(contractId, [...registeredBatch, ...phantomBatch]);
}

/** 演练：调用方完成升级，旧版本流量归零、基线版本承接流量 */
export async function simulateCallerUpgrade(
  contractId: string,
  candidate: ReconCandidate,
): Promise<Reconciliation> {
  const baseline =
    readReconciliations()[contractId]?.baselineClientVersion ?? candidate.clientVersion;
  const capturedAt = new Date().toISOString();
  const batch: TrafficSnapshot[] = [
    {
      id: `snap-${Date.now()}-retire`,
      contractId,
      callerId: candidate.callerId,
      callerName: candidate.callerName,
      clientVersion: candidate.clientVersion,
      environment: '生产',
      requestsPerDay: 0,
      capturedAt,
    },
    {
      id: `snap-${Date.now()}-upgrade`,
      contractId,
      callerId: candidate.callerId,
      callerName: candidate.callerName,
      clientVersion: baseline,
      environment: '生产',
      requestsPerDay: candidate.requestsPerDay,
      capturedAt,
    },
  ];
  return ingestTrafficSnapshots(contractId, batch);
}

/** 登记调用方维度的兼容层豁免（绑定当前差异指纹），随后重算候选 */
export async function grantCallerExemption(input: {
  contractId: string;
  changeId: string;
  callerId: string;
  callerName: string;
  reason: string;
  expiresAt: string;
}): Promise<ApiContract> {
  const contracts = await listContracts();
  const contract = contracts.find((item) => item.id === input.contractId);
  if (!contract) throw new Error('契约不存在');
  const change = contract.changes.find((item) => item.id === input.changeId);
  if (!change) throw new Error('变更不存在');

  const exemption: Exemption = {
    id: `ex-${Date.now()}`,
    changeId: input.changeId,
    scope: input.callerId ? `调用方 ${input.callerName}` : '全部调用方',
    reason: input.reason,
    approvedBy: '当前评审人',
    expiresAt: input.expiresAt,
    callerId: input.callerId || undefined,
    diffFingerprint: diffFingerprint(change),
  };
  const updated: ApiContract = { ...contract, exemptions: [...contract.exemptions, exemption] };
  await saveContract(updated);
  await runReconciliation(input.contractId);
  return updated;
}

/** 演练：契约负责人修订差异内容，已绑定旧指纹的豁免随即失效 */
export async function reviseChangeDiff(contractId: string, changeId: string): Promise<ApiContract> {
  const contract = await requireContract(contractId);
  const change = contract.changes.find((item) => item.id === changeId);
  if (!change) throw new Error('变更不存在');
  const marker = `（演练修订 ${new Date().toISOString().slice(11, 19)}）`;
  const updated: ApiContract = {
    ...contract,
    changes: contract.changes.map((item) =>
      item.id === changeId ? { ...item, after: `${item.after}${marker}` } : item,
    ),
  };
  return saveContract(updated);
}
