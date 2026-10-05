import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReconCandidate } from '../models/reconciliation';
import { contractKeys } from './contract-queries';
import {
  getReconCheckpoint,
  getReconciliation,
  getTrafficSnapshots,
  grantCallerExemption,
  ingestGatewaySnapshot,
  resumeReconciliation,
  reviseChangeDiff,
  runReconciliation,
  simulateCallerUpgrade,
} from './reconciliation-service';

export const reconKeys = {
  snapshots: (contractId: string) => ['recon-snapshots', contractId] as const,
  record: (contractId: string) => ['reconciliation', contractId] as const,
  checkpoint: (contractId: string) => ['recon-checkpoint', contractId] as const,
};

export function useTrafficSnapshots(contractId: string) {
  return useQuery({
    queryKey: reconKeys.snapshots(contractId),
    queryFn: () => getTrafficSnapshots(contractId),
    enabled: Boolean(contractId),
  });
}

export function useReconciliation(contractId: string) {
  return useQuery({
    queryKey: reconKeys.record(contractId),
    queryFn: () => getReconciliation(contractId),
    enabled: Boolean(contractId),
  });
}

export function useReconCheckpoint(contractId: string) {
  return useQuery({
    queryKey: reconKeys.checkpoint(contractId),
    queryFn: () => getReconCheckpoint(contractId),
    enabled: Boolean(contractId),
  });
}

function useInvalidateRecon() {
  const queryClient = useQueryClient();
  return (contractId: string) => {
    void queryClient.invalidateQueries({ queryKey: reconKeys.snapshots(contractId) });
    void queryClient.invalidateQueries({ queryKey: reconKeys.record(contractId) });
    void queryClient.invalidateQueries({ queryKey: reconKeys.checkpoint(contractId) });
    void queryClient.invalidateQueries({ queryKey: contractKeys.all });
  };
}

export function useRunReconciliation() {
  const invalidate = useInvalidateRecon();
  return useMutation({
    mutationFn: (input: { contractId: string; baselineClientVersion?: string }) =>
      runReconciliation(input.contractId, input),
    // 冲突或写入失败后同样刷新，让后到者看到最新版本与检查点
    onSettled: (_data, _error, variables) => invalidate(variables.contractId),
  });
}

export function useResumeReconciliation() {
  const invalidate = useInvalidateRecon();
  return useMutation({
    mutationFn: (contractId: string) => resumeReconciliation(contractId),
    onSettled: (_data, _error, contractId) => invalidate(contractId),
  });
}

export function useIngestGatewaySnapshot() {
  const invalidate = useInvalidateRecon();
  return useMutation({
    mutationFn: (contractId: string) => ingestGatewaySnapshot(contractId),
    onSettled: (_data, _error, contractId) => invalidate(contractId),
  });
}

export function useSimulateCallerUpgrade() {
  const invalidate = useInvalidateRecon();
  return useMutation({
    mutationFn: (input: { contractId: string; candidate: ReconCandidate }) =>
      simulateCallerUpgrade(input.contractId, input.candidate),
    onSettled: (_data, _error, variables) => invalidate(variables.contractId),
  });
}

export function useGrantCallerExemption() {
  const invalidate = useInvalidateRecon();
  return useMutation({
    mutationFn: (input: {
      contractId: string;
      changeId: string;
      callerId: string;
      callerName: string;
      reason: string;
      expiresAt: string;
    }) => grantCallerExemption(input),
    onSettled: (_data, _error, variables) => invalidate(variables.contractId),
  });
}

export function useReviseChangeDiff() {
  const invalidate = useInvalidateRecon();
  return useMutation({
    mutationFn: (input: { contractId: string; changeId: string }) =>
      reviseChangeDiff(input.contractId, input.changeId),
    onSettled: (_data, _error, variables) => invalidate(variables.contractId),
  });
}
