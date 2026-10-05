import { seedTrafficSnapshots } from '../data/traffic-seed';
import type { ApiContract } from '../models/contract';
import {
  computeReconciliation,
  dedupeSnapshots,
  recomputeAffectedCandidates,
  type ReconciliationRun,
  type ReconciliationStore,
  type TrafficSnapshot,
} from '../models/reconciliation';

export const RECONCILIATION_STORE_KEY = 'pair-wise-gsb-70-reconciliation';
export const RECONCILIATION_CHECKPOINT_KEY = 'pair-wise-gsb-70-reconciliation-checkpoint';
const LATENCY = 180;
const MAX_COMMIT_ATTEMPTS = 5;

export class RevisionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RevisionConflictError';
  }
}

export class ReconciliationWriteError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReconciliationWriteError';
  }
}

export interface CommitOutcome<T> {
  result: T;
  revision: number;
  /** 提交时发现另一窗口已写入，本次基于最新版本重放 */
  rebased: boolean;
}

export interface RecoveryNotice {
  revision: number;
  recoveredAt: string;
}

export type NewTrafficSnapshot = Omit<TrafficSnapshot, 'id' | 'contractId'>;

export interface IngestOutcome {
  accepted: number;
  effectiveSnapshots: number;
  affectedCallers: string[];
  recomputedCandidates: number;
}

let failNextWrite = false;
let lastRecovery: RecoveryNotice | null = null;

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function wait(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, LATENCY));
}

function readStore(): ReconciliationStore | null {
  const raw = localStorage.getItem(RECONCILIATION_STORE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ReconciliationStore;
  } catch {
    localStorage.removeItem(RECONCILIATION_STORE_KEY);
    return null;
  }
}

function readCheckpoint(): { savedAt: string; store: ReconciliationStore } | null {
  const raw = localStorage.getItem(RECONCILIATION_CHECKPOINT_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as { savedAt: string; store: ReconciliationStore };
  } catch {
    localStorage.removeItem(RECONCILIATION_CHECKPOINT_KEY);
    return null;
  }
}

function loadStore(): ReconciliationStore {
  const checkpoint = readCheckpoint();
  if (checkpoint) {
    const onDisk = readStore();
    if (!onDisk || checkpoint.store.revision > onDisk.revision) {
      // 上次提交在主存储落盘前失败：从检查点恢复
      lastRecovery = {
        revision: checkpoint.store.revision,
        recoveredAt: new Date().toISOString(),
      };
      try {
        localStorage.setItem(RECONCILIATION_STORE_KEY, JSON.stringify(checkpoint.store));
        localStorage.removeItem(RECONCILIATION_CHECKPOINT_KEY);
      } catch {
        // 主存储仍不可写：保留检查点，下次读取继续恢复
      }
      return clone(checkpoint.store);
    }
    // 主存储已包含该提交，仅清理残留检查点
    localStorage.removeItem(RECONCILIATION_CHECKPOINT_KEY);
  }
  const stored = readStore();
  if (stored) return stored;
  const initial: ReconciliationStore = {
    revision: 1,
    snapshots: dedupeSnapshots(seedTrafficSnapshots),
    runs: [],
  };
  try {
    localStorage.setItem(RECONCILIATION_STORE_KEY, JSON.stringify(initial));
  } catch {
    // 存储不可用时以只读方式工作
  }
  return clone(initial);
}

/** 先写检查点再写主存储；主存储失败时保留检查点，等待下次读取恢复 */
function persistWithCheckpoint(store: ReconciliationStore): void {
  localStorage.setItem(
    RECONCILIATION_CHECKPOINT_KEY,
    JSON.stringify({ savedAt: new Date().toISOString(), store }),
  );
  try {
    if (failNextWrite) {
      failNextWrite = false;
      throw new Error('模拟写入失败');
    }
    localStorage.setItem(RECONCILIATION_STORE_KEY, JSON.stringify(store));
  } catch (error) {
    throw new ReconciliationWriteError('主存储写入失败，已保留检查点，下次读取自动恢复。', {
      cause: error,
    });
  }
  localStorage.removeItem(RECONCILIATION_CHECKPOINT_KEY);
}

/**
 * 基于版本号的乐观提交：写入前重新读取存储，若另一窗口已提交（版本号变化），
 * 后到者基于最新版本重放变更，而不是盲目覆盖。
 */
function commit<T>(
  mutate: (store: ReconciliationStore) => { store: ReconciliationStore; result: T },
): CommitOutcome<T> {
  let rebased = false;
  for (let attempt = 0; attempt < MAX_COMMIT_ATTEMPTS; attempt += 1) {
    const current = loadStore();
    const { store: next, result } = mutate(clone(current));
    next.revision = current.revision + 1;
    const onDisk = readStore();
    if (onDisk && onDisk.revision !== current.revision) {
      rebased = true;
      continue;
    }
    persistWithCheckpoint(next);
    return { result, revision: next.revision, rebased };
  }
  throw new RevisionConflictError('多个窗口同时提交，重试后仍存在版本冲突。');
}

export async function getReconciliationStore(): Promise<{
  store: ReconciliationStore;
  recovery: RecoveryNotice | null;
}> {
  await wait();
  const store = loadStore();
  const recovery = lastRecovery;
  lastRecovery = null;
  return { store, recovery };
}

/** 接入网关流量快照：同调用方同版本只留最新，随后只重算受影响调用方的候选 */
export async function ingestTrafficSnapshots(
  contract: ApiContract,
  batch: NewTrafficSnapshot[],
): Promise<CommitOutcome<IngestOutcome>> {
  await wait();
  return commit((store) => {
    const incoming = batch.map((item, index) => ({
      ...item,
      id: `snap-${Date.now()}-${index}`,
      contractId: contract.id,
    }));
    const snapshots = dedupeSnapshots([...store.snapshots, ...incoming]);
    const affectedCallers = [...new Set(incoming.map((snapshot) => snapshot.callerId))];
    const now = new Date();
    const existing = store.runs.find((run) => run.contractId === contract.id);
    let run: ReconciliationRun;
    let recomputedCandidates: number;
    if (existing) {
      const recomputed = recomputeAffectedCandidates(
        existing,
        contract,
        snapshots,
        affectedCallers,
        now,
      );
      run = recomputed.run;
      recomputedCandidates = recomputed.recomputed;
    } else {
      run = computeReconciliation(contract, snapshots, now);
      recomputedCandidates = run.candidates.length;
    }
    const runs = [run, ...store.runs.filter((item) => item.contractId !== contract.id)];
    return {
      store: { ...store, snapshots, runs },
      result: {
        accepted: incoming.length,
        effectiveSnapshots: snapshots.filter(
          (snapshot) => snapshot.contractId === contract.id,
        ).length,
        affectedCallers,
        recomputedCandidates,
      },
    };
  });
}

/** 全量重算当前契约的对账结果 */
export async function runReconciliation(
  contract: ApiContract,
): Promise<CommitOutcome<ReconciliationRun>> {
  await wait();
  return commit((store) => {
    const run = computeReconciliation(contract, store.snapshots, new Date());
    return {
      store: {
        ...store,
        runs: [run, ...store.runs.filter((item) => item.contractId !== contract.id)],
      },
      result: run,
    };
  });
}

/** 故障演练：让下一次主存储写入失败，用于验证检查点恢复 */
export function failNextReconciliationWrite(): void {
  failNextWrite = true;
}
