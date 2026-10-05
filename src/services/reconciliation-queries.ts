import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { ApiContract } from '../models/contract';
import {
  getReconciliationStore,
  ingestTrafficSnapshots,
  RECONCILIATION_CHECKPOINT_KEY,
  RECONCILIATION_STORE_KEY,
  runReconciliation,
  type NewTrafficSnapshot,
} from './reconciliation-service';

export const reconciliationKeys = {
  all: ['reconciliation'] as const,
  store: () => ['reconciliation', 'store'] as const,
};

export function useReconciliationStore() {
  return useQuery({
    queryKey: reconciliationKeys.store(),
    queryFn: getReconciliationStore,
  });
}

export function useIngestSnapshots() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { contract: ApiContract; batch: NewTrafficSnapshot[] }) =>
      ingestTrafficSnapshots(input.contract, input.batch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: reconciliationKeys.all }),
  });
}

export function useRunReconciliation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (contract: ApiContract) => runReconciliation(contract),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: reconciliationKeys.all }),
  });
}

/** 另一窗口提交后 localStorage 变化会触发 storage 事件，这里让本窗口查询失效 */
export function useReconciliationCrossTabSync() {
  const queryClient = useQueryClient();
  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (
        event.key === RECONCILIATION_STORE_KEY ||
        event.key === RECONCILIATION_CHECKPOINT_KEY
      ) {
        void queryClient.invalidateQueries({ queryKey: reconciliationKeys.all });
      }
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [queryClient]);
}
