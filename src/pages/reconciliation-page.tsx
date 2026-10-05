import { Link } from '@tanstack/react-router';
import {
  CheckCircle2,
  CircleArrowUp,
  FileWarning,
  History,
  Layers3,
  Radar,
  RefreshCw,
  Scale,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { Textarea } from '../components/ui/textarea';
import { formatDateTime, formatNumber } from '../lib/utils';
import {
  diffFingerprint,
  EXEMPTION_VALIDITY_LABELS,
  exemptionValidity,
  type ExemptionValidity,
} from '../models/contract';
import {
  contractDiffFingerprint,
  RECON_STAGE_LABELS,
  reconciliationGateIssues,
  suggestBaseline,
} from '../models/reconciliation';
import { useContracts } from '../services/contract-queries';
import {
  useGrantCallerExemption,
  useIngestGatewaySnapshot,
  useReconCheckpoint,
  useReconciliation,
  useResumeReconciliation,
  useReviseChangeDiff,
  useRunReconciliation,
  useSimulateCallerUpgrade,
  useTrafficSnapshots,
} from '../services/reconciliation-queries';
import {
  armPersistFailureDrill,
  RevisionConflictError,
  ReconPersistError,
} from '../services/reconciliation-service';
import { useReviewStore } from '../store/review-store';

interface Notice {
  tone: 'error' | 'info';
  text: string;
}

function describeError(error: unknown): string {
  if (error instanceof RevisionConflictError) {
    return `检测到并发提交：本次计算基于 rev ${error.expected}，提交时最新已是 rev ${error.current}。后到提交已被拦截，请基于最新对账结果重算。`;
  }
  if (error instanceof ReconPersistError) {
    return `${error.message}。可从检查点恢复，不必从头重算。`;
  }
  return error instanceof Error ? error.message : '操作失败';
}

export function ReconciliationPage() {
  const contracts = useContracts();
  const selectedContractId = useReviewStore((state) => state.selectedContractId);
  const setSelectedContract = useReviewStore((state) => state.setSelectedContract);

  const reconQuery = useReconciliation(selectedContractId);
  const snapshotsQuery = useTrafficSnapshots(selectedContractId);
  const checkpointQuery = useReconCheckpoint(selectedContractId);

  const runRecon = useRunReconciliation();
  const resumeRecon = useResumeReconciliation();
  const ingest = useIngestGatewaySnapshot();
  const simulateUpgrade = useSimulateCallerUpgrade();
  const grantExemption = useGrantCallerExemption();
  const reviseDiff = useReviseChangeDiff();

  const [baselineEdits, setBaselineEdits] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [exemptionChangeId, setExemptionChangeId] = useState('');
  const [exemptionCaller, setExemptionCaller] = useState('');
  const [exemptionReason, setExemptionReason] = useState('');
  const [exemptionExpires, setExemptionExpires] = useState('');

  const contract = (contracts.data ?? []).find((item) => item.id === selectedContractId);
  const recon = reconQuery.data;
  const checkpoint = checkpointQuery.data;

  // 基线输入：未编辑时跟随对账结果或建议值，编辑按契约保留
  const suggestedBaseline = contract
    ? (recon?.baselineClientVersion ?? suggestBaseline(contract))
    : '';
  const baselineInput = baselineEdits[selectedContractId] ?? suggestedBaseline;
  const setBaselineInput = (value: string) =>
    setBaselineEdits((edits) => ({ ...edits, [selectedContractId]: value }));

  const breakingChanges = useMemo(
    () => contract?.changes.filter((change) => change.compatibility === 'breaking') ?? [],
    [contract],
  );
  const candidates = useMemo(
    () =>
      [...(recon?.candidates ?? [])].sort((a, b) =>
        a.status === b.status ? b.requestsPerDay - a.requestsPerDay : a.status === 'blocked' ? -1 : 1,
      ),
    [recon],
  );
  const blockedCount = candidates.filter((candidate) => candidate.status === 'blocked').length;
  const staleRecon = Boolean(
    contract && recon && recon.diffFingerprint !== contractDiffFingerprint(contract.changes),
  );
  const gateIssues = useMemo(
    () =>
      contract && !reconQuery.isLoading ? reconciliationGateIssues(contract, recon) : [],
    [contract, recon, reconQuery.isLoading],
  );
  const callerOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const candidate of candidates) map.set(candidate.callerId, candidate.callerName);
    return [...map.entries()].map(([callerId, callerName]) => ({ callerId, callerName }));
  }, [candidates]);

  async function guard(action: () => Promise<unknown>, success: string) {
    setNotice(null);
    try {
      await action();
      setNotice({ tone: 'info', text: success });
    } catch (error) {
      setNotice({ tone: 'error', text: describeError(error) });
    }
  }

  function openExemptionPanel(changeId: string) {
    setExemptionChangeId(changeId);
    setExemptionCaller('');
    setExemptionReason('');
    setExemptionExpires(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  }

  const busy =
    runRecon.isPending ||
    resumeRecon.isPending ||
    ingest.isPending ||
    simulateUpgrade.isPending ||
    grantExemption.isPending;

  return (
    <div>
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-sky-800">
          Release Reconciliation
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-950 sm:text-3xl">上线对账</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          冻结版本、网关流量快照与兼容层豁免在此对账：只有未升级且仍有生产流量的调用方，
          才会让不兼容变化挡住发布。
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>选择对账契约</CardTitle>
            <p className="mt-1 text-xs text-slate-500">
              对账以网关快照为准，登记清单之外的旧客户端也会被发现
            </p>
          </div>
          <Select value={selectedContractId} onValueChange={setSelectedContract}>
            <SelectTrigger className="w-full sm:w-72">
              <SelectValue placeholder="选择一个契约" />
            </SelectTrigger>
            <SelectContent>
              {(contracts.data ?? []).map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name} · v{item.version}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardHeader>
      </Card>

      {!contract && (
        <p className="mt-4 rounded-lg border border-slate-200 bg-white px-4 py-16 text-center text-sm text-slate-500">
          选择一个契约开始上线对账。
        </p>
      )}

      {contract && (
        <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_400px]">
          <div className="space-y-4">
            <Card>
              <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <CardTitle>受影响候选</CardTitle>
                  <p className="mt-1 text-xs text-slate-500">
                    未升级到 {recon?.baselineClientVersion ?? (baselineInput || '基线版本')}{' '}
                    且仍有生产流量的调用方
                  </p>
                </div>
                {recon && (
                  <Badge tone={blockedCount ? 'red' : 'green'}>
                    {blockedCount ? `${blockedCount} 个调用方挡住发布` : '无阻断候选'}
                  </Badge>
                )}
              </CardHeader>
              <CardContent className="p-0">
                {!recon && (
                  <div className="px-4 py-12 text-center">
                    <p className="text-sm text-slate-500">
                      {breakingChanges.length
                        ? '尚未执行上线对账，发布门禁会挡住该契约。'
                        : '尚未执行上线对账。'}
                    </p>
                    <Button
                      className="mt-4"
                      disabled={busy}
                      onClick={() =>
                        void guard(
                          () =>
                            runRecon.mutateAsync({
                              contractId: contract.id,
                              baselineClientVersion: baselineInput.trim() || undefined,
                            }),
                          '对账完成，受影响候选已重算。',
                        )
                      }
                    >
                      <Scale className="h-4 w-4" />
                      立即对账
                    </Button>
                  </div>
                )}
                {recon && !candidates.length && (
                  <div className="m-4 flex items-start gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-4">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-700" />
                    <p className="text-sm text-emerald-900">
                      网关快照中没有未升级的生产调用方，不兼容变化不会挡住发布。
                    </p>
                  </div>
                )}
                {recon && candidates.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[760px] text-left text-sm">
                      <thead className="bg-slate-50 text-xs text-slate-500">
                        <tr>
                          <th className="px-4 py-3 font-medium">调用方</th>
                          <th className="px-4 py-3 font-medium">在跑版本</th>
                          <th className="px-4 py-3 font-medium">生产日流量</th>
                          <th className="px-4 py-3 font-medium">最新快照</th>
                          <th className="px-4 py-3 font-medium">豁免覆盖</th>
                          <th className="px-4 py-3 font-medium">状态</th>
                          <th className="px-4 py-3 font-medium" />
                        </tr>
                      </thead>
                      <tbody>
                        {candidates.map((candidate) => (
                          <tr
                            key={`${candidate.callerId}-${candidate.clientVersion}`}
                            className="border-t border-slate-100"
                          >
                            <td className="px-4 py-3">
                              <div className="font-medium text-slate-900">{candidate.callerName}</div>
                              {!candidate.registered && (
                                <Badge tone="amber" className="mt-1">
                                  未登记
                                </Badge>
                              )}
                            </td>
                            <td className="px-4 py-3 font-mono text-xs text-slate-700">
                              {candidate.clientVersion}
                            </td>
                            <td className="px-4 py-3 text-slate-700">
                              {formatNumber(candidate.requestsPerDay)}
                            </td>
                            <td className="px-4 py-3 text-xs text-slate-500">
                              {formatDateTime(candidate.capturedAt)}
                            </td>
                            <td className="px-4 py-3 text-xs text-slate-600">
                              {candidate.coveredChangeIds.length}/
                              {candidate.coveredChangeIds.length + candidate.uncoveredChangeIds.length} 项
                            </td>
                            <td className="px-4 py-3">
                              {candidate.status === 'blocked' ? (
                                <Badge tone="red">挡住发布</Badge>
                              ) : (
                                <Badge tone="green">已豁免</Badge>
                              )}
                            </td>
                            <td className="px-4 py-3 text-right">
                              {candidate.status === 'blocked' && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={busy}
                                  onClick={() =>
                                    void guard(
                                      () =>
                                        simulateUpgrade.mutateAsync({
                                          contractId: contract.id,
                                          candidate,
                                        }),
                                      `${candidate.callerName} 已升级到基线版本，受影响候选已重算。`,
                                    )
                                  }
                                >
                                  <CircleArrowUp className="h-3.5 w-3.5" />
                                  模拟升级
                                </Button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <CardTitle>网关流量快照</CardTitle>
                  <p className="mt-1 text-xs text-slate-500">
                    {snapshotsQuery.data
                      ? `原始 ${snapshotsQuery.data.rawCount} 条 → 去重后 ${snapshotsQuery.data.snapshots.length} 条，同一调用方同一版本只认最新快照`
                      : '同一调用方同一版本只认最新快照'}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void guard(
                      () => ingest.mutateAsync(contract.id),
                      '已接收网关快照，受影响候选已重算。',
                    )
                  }
                >
                  <Radar className="h-3.5 w-3.5" />
                  接收网关快照
                </Button>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[680px] text-left text-sm">
                    <thead className="bg-slate-50 text-xs text-slate-500">
                      <tr>
                        <th className="px-4 py-3 font-medium">调用方</th>
                        <th className="px-4 py-3 font-medium">客户端版本</th>
                        <th className="px-4 py-3 font-medium">环境</th>
                        <th className="px-4 py-3 font-medium">日流量</th>
                        <th className="px-4 py-3 font-medium">采集时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(snapshotsQuery.data?.snapshots ?? []).map((snapshot) => (
                        <tr key={snapshot.id} className="border-t border-slate-100">
                          <td className="px-4 py-3 font-medium text-slate-900">
                            {snapshot.callerName}
                          </td>
                          <td className="px-4 py-3 font-mono text-xs text-slate-700">
                            {snapshot.clientVersion}
                          </td>
                          <td className="px-4 py-3">
                            <Badge tone={snapshot.environment === '生产' ? 'blue' : 'neutral'}>
                              {snapshot.environment}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 text-slate-700">
                            {formatNumber(snapshot.requestsPerDay)}
                          </td>
                          <td className="px-4 py-3 text-xs text-slate-500">
                            {formatDateTime(snapshot.capturedAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!snapshotsQuery.data?.snapshots.length && (
                    <p className="px-4 py-10 text-center text-sm text-slate-500">
                      暂无网关快照，点击「接收网关快照」模拟网关上報。
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>对账状态</CardTitle>
                <p className="mt-1 text-xs text-slate-500">
                  {recon
                    ? `rev ${recon.revision} · 计算于 ${formatDateTime(recon.computedAt)}`
                    : '尚未生成对账结果'}
                </p>
              </CardHeader>
              <CardContent>
                {recon && (
                  <dl className="space-y-2 text-xs text-slate-600">
                    <div className="flex items-center justify-between">
                      <dt>兼容基线</dt>
                      <dd className="font-mono text-slate-900">{recon.baselineClientVersion}</dd>
                    </div>
                    <div className="flex items-center justify-between">
                      <dt>差异指纹</dt>
                      <dd className="font-mono text-slate-900">{recon.diffFingerprint}</dd>
                    </div>
                    <div className="flex items-center justify-between">
                      <dt>快照去重</dt>
                      <dd className="font-mono text-slate-900">
                        {recon.sourceSnapshotCount} → {recon.dedupedSnapshotCount}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between">
                      <dt>发布门禁</dt>
                      <dd>
                        {gateIssues.length ? (
                          <Badge tone="red">{gateIssues.length} 个阻断项</Badge>
                        ) : (
                          <Badge tone="green">通过</Badge>
                        )}
                      </dd>
                    </div>
                  </dl>
                )}

                {staleRecon && (
                  <div className="mt-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-900">
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    不兼容差异在对账后发生变化，对账结果已失效，请重新对账。
                  </div>
                )}

                {checkpoint && (
                  <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3">
                    <div className="flex items-start gap-2 text-xs text-amber-900">
                      <History className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>
                        上次对账在「{RECON_STAGE_LABELS[checkpoint.nextStage]}」前中断（基于 rev{' '}
                        {checkpoint.baseRevision}，{formatDateTime(checkpoint.savedAt)}），
                        可从检查点恢复。
                      </span>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="mt-3 w-full"
                      disabled={busy}
                      onClick={() =>
                        void guard(
                          () => resumeRecon.mutateAsync(contract.id),
                          '已从检查点恢复，对账结果已写入。',
                        )
                      }
                    >
                      <History className="h-3.5 w-3.5" />
                      从检查点恢复
                    </Button>
                  </div>
                )}

                {notice && (
                  <div
                    className={
                      notice.tone === 'error'
                        ? 'mt-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-900'
                        : 'mt-3 flex items-start gap-2 rounded-md border border-sky-200 bg-sky-50 p-3 text-xs text-sky-900'
                    }
                  >
                    {notice.tone === 'error' ? (
                      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    ) : (
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                    )}
                    {notice.text}
                  </div>
                )}

                <label className="mt-4 block text-xs font-medium text-slate-700">
                  兼容基线版本（达到即视为已升级）
                </label>
                <Input
                  className="mt-1.5 font-mono"
                  value={baselineInput}
                  onChange={(event) => setBaselineInput(event.target.value)}
                  placeholder="例如 4.7.0"
                />
                <Button
                  className="mt-3 w-full"
                  disabled={busy || !baselineInput.trim()}
                  onClick={() =>
                    void guard(
                      () =>
                        runRecon.mutateAsync({
                          contractId: contract.id,
                          baselineClientVersion: baselineInput.trim(),
                        }),
                      '对账完成，受影响候选已重算。',
                    )
                  }
                >
                  <RefreshCw className="h-4 w-4" />
                  {runRecon.isPending ? '对账中' : '重新对账'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2 w-full"
                  disabled={busy}
                  onClick={() => {
                    armPersistFailureDrill();
                    setNotice({
                      tone: 'info',
                      text: '演练已就绪：下一次对账写入将模拟失败，随后可从检查点恢复。',
                    });
                  }}
                >
                  <FileWarning className="h-3.5 w-3.5" />
                  演练：下次写入失败
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>不兼容变化与豁免</CardTitle>
                <p className="mt-1 text-xs text-slate-500">
                  豁免绑定登记时的差异指纹，过期或差异变化即失效
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                {!breakingChanges.length && (
                  <p className="text-sm text-slate-500">
                    当前工作副本没有不兼容变化，无需调用方豁免。
                  </p>
                )}
                {breakingChanges.map((change) => {
                  const fingerprint = diffFingerprint(change);
                  const exemptions = contract.exemptions.filter(
                    (item) => item.changeId === change.id,
                  );
                  return (
                    <div key={change.id} className="rounded-md border border-slate-200 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <span className="font-mono text-xs font-semibold text-sky-900">
                            {change.method} {change.path}
                          </span>
                          <p className="mt-1 text-[11px] text-slate-500">
                            差异指纹 <span className="font-mono">{fingerprint}</span>
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy || reviseDiff.isPending}
                          onClick={() =>
                            void guard(
                              () =>
                                reviseDiff.mutateAsync({
                                  contractId: contract.id,
                                  changeId: change.id,
                                }),
                              '差异已修订：绑定旧指纹的豁免失效，请重新对账。',
                            )
                          }
                        >
                          演练：修订差异
                        </Button>
                      </div>

                      <div className="mt-3 space-y-2">
                        {exemptions.map((exemption) => {
                          const validity: ExemptionValidity = exemptionValidity(exemption, change);
                          const tone = (
                            {
                              valid: 'green',
                              expired: 'amber',
                              diff_changed: 'red',
                              unbound: 'neutral',
                            } as const
                          )[validity];
                          return (
                            <div
                              key={exemption.id}
                              className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2 text-xs"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-medium text-slate-800">{exemption.scope}</span>
                                <Badge tone={tone}>{EXEMPTION_VALIDITY_LABELS[validity]}</Badge>
                              </div>
                              <p className="mt-1 text-slate-600">{exemption.reason}</p>
                              <p className="mt-1 text-[11px] text-slate-500">
                                {exemption.approvedBy} · 至 {exemption.expiresAt} · 指纹{' '}
                                <span className="font-mono">
                                  {exemption.diffFingerprint ?? '未绑定'}
                                </span>
                              </p>
                            </div>
                          );
                        })}
                        {!exemptions.length && (
                          <p className="text-xs text-slate-500">尚无豁免记录。</p>
                        )}
                      </div>

                      {exemptionChangeId === change.id ? (
                        <div className="mt-3 rounded-md border border-blue-200 bg-blue-50 p-3">
                          <label className="block text-xs font-medium text-slate-700">覆盖调用方</label>
                          <Select value={exemptionCaller} onValueChange={setExemptionCaller}>
                            <SelectTrigger className="mt-1.5 bg-white">
                              <SelectValue placeholder="全部调用方" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__all__">全部调用方</SelectItem>
                              {callerOptions.map((option) => (
                                <SelectItem key={option.callerId} value={option.callerId}>
                                  {option.callerName}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <label className="mt-3 block text-xs font-medium text-slate-700">
                            豁免原因
                          </label>
                          <Textarea
                            className="mt-1.5 bg-white"
                            value={exemptionReason}
                            onChange={(event) => setExemptionReason(event.target.value)}
                            placeholder="兼容层覆盖范围与升级计划"
                          />
                          <label className="mt-3 block text-xs font-medium text-slate-700">
                            到期日
                          </label>
                          <Input
                            type="date"
                            className="mt-1.5 bg-white"
                            value={exemptionExpires}
                            onChange={(event) => setExemptionExpires(event.target.value)}
                          />
                          <div className="mt-3 flex justify-end gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setExemptionChangeId('')}
                            >
                              取消
                            </Button>
                            <Button
                              size="sm"
                              disabled={!exemptionReason.trim() || !exemptionExpires || busy}
                              onClick={() =>
                                void guard(
                                  () =>
                                    grantExemption.mutateAsync({
                                      contractId: contract.id,
                                      changeId: change.id,
                                      callerId: exemptionCaller === '__all__' ? '' : exemptionCaller,
                                      callerName:
                                        exemptionCaller === '__all__'
                                          ? '全部调用方'
                                          : (callerOptions.find(
                                              (option) => option.callerId === exemptionCaller,
                                            )?.callerName ?? exemptionCaller),
                                      reason: exemptionReason.trim(),
                                      expiresAt: exemptionExpires,
                                    }).then(() => setExemptionChangeId('')),
                                  '豁免已登记并绑定当前差异指纹，受影响候选已重算。',
                                )
                              }
                            >
                              登记豁免
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="mt-3"
                          disabled={busy}
                          onClick={() => openExemptionPanel(change.id)}
                        >
                          <Layers3 className="h-3.5 w-3.5" />
                          登记调用方豁免
                        </Button>
                      )}
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>对账规则</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 text-sm text-slate-600">
                <Policy icon={Radar} text="同一调用方同一客户端版本只认最新网关快照。" />
                <Policy icon={ShieldAlert} text="只有未升级且有生产流量的调用方才会挡住发布。" />
                <Policy icon={Layers3} text="豁免绑定差异指纹，过期或差异变化即失效。" />
                <Policy icon={RefreshCw} text="快照更新后自动重算受影响候选。" />
                <Policy icon={History} text="写入失败可从检查点恢复，不必从头重算。" />
                <Policy icon={ShieldCheck} text="并发提交时后到者看到版本变化，基于最新结果重算。" />
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {contract && gateIssues.length > 0 && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          当前 {gateIssues.length} 个对账阻断项会挡住发布，可前往
          <Link to="/releases" className="mx-1 font-medium text-red-950 underline">
            版本发布
          </Link>
          查看合并后的发布门禁。
        </div>
      )}
    </div>
  );
}

function Policy({ icon: Icon, text }: { icon: typeof Radar; text: string }) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-sky-800" />
      <span>{text}</span>
    </div>
  );
}
