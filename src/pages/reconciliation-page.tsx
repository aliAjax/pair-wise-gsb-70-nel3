import { Link } from '@tanstack/react-router';
import {
  CheckCircle2,
  CloudUpload,
  FileClock,
  Radar,
  RefreshCcw,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { formatDateTime, formatNumber } from '../lib/utils';
import { evaluateExemption } from '../models/contract';
import {
  CANDIDATE_STATUS_LABELS,
  computeCandidates,
  dedupeSnapshots,
  summarizeCandidates,
  type CandidateStatus,
} from '../models/reconciliation';
import { useContracts } from '../services/contract-queries';
import {
  useIngestSnapshots,
  useReconciliationCrossTabSync,
  useReconciliationStore,
  useRunReconciliation,
} from '../services/reconciliation-queries';
import { failNextReconciliationWrite } from '../services/reconciliation-service';
import { useReviewStore } from '../store/review-store';

const STATUS_TONES: Record<CandidateStatus, 'red' | 'blue' | 'green' | 'neutral' | 'amber'> = {
  blocked: 'red',
  exempted: 'blue',
  upgraded: 'green',
  'no-production-traffic': 'neutral',
  'no-snapshot': 'amber',
};

export function ReconciliationPage() {
  const contracts = useContracts();
  const reconciliation = useReconciliationStore();
  useReconciliationCrossTabSync();
  const ingest = useIngestSnapshots();
  const runReconciliation = useRunReconciliation();
  const selectedContractId = useReviewStore((state) => state.selectedContractId);
  const setSelectedContract = useReviewStore((state) => state.setSelectedContract);
  const [notice, setNotice] = useState('');
  const [writeError, setWriteError] = useState('');
  const [drillArmed, setDrillArmed] = useState(false);
  const [callerId, setCallerId] = useState('');
  const [clientVersion, setClientVersion] = useState('');
  const [environment, setEnvironment] = useState<'生产' | '预发' | '灰度'>('生产');
  const [requestsPerDay, setRequestsPerDay] = useState('');
  const [now] = useState(() => new Date());

  const store = reconciliation.data?.store;
  const recovery = reconciliation.data?.recovery ?? null;
  const contract = (contracts.data ?? []).find((item) => item.id === selectedContractId);

  const snapshots = useMemo(
    () =>
      store && contract
        ? dedupeSnapshots(store.snapshots).filter((item) => item.contractId === contract.id)
        : [],
    [store, contract],
  );
  const candidates = useMemo(
    () => (contract && store ? computeCandidates(contract, store.snapshots, now) : []),
    [contract, store, now],
  );
  const summary = useMemo(() => summarizeCandidates(candidates), [candidates]);
  const run = store?.runs.find((item) => item.contractId === contract?.id);
  const exemptions = useMemo(
    () =>
      (contract?.exemptions ?? []).map((exemption) => ({
        exemption,
        validity: evaluateExemption(
          exemption,
          contract?.changes.find((change) => change.id === exemption.changeId),
        ),
      })),
    [contract],
  );
  const callerOptions = useMemo(() => {
    if (!contract) return [];
    const registered = contract.consumers.map((consumer) => ({
      id: consumer.id,
      name: consumer.name,
      version: consumer.clientVersion,
    }));
    const known = new Set(registered.map((option) => option.id));
    const external = snapshots
      .filter((snapshot) => !known.has(snapshot.callerId))
      .map((snapshot) => ({
        id: snapshot.callerId,
        name: `${snapshot.callerName}（未登记）`,
        version: snapshot.clientVersion,
      }));
    return [...registered, ...external];
  }, [contract, snapshots]);

  async function submitSnapshot() {
    if (!contract || !callerId || !clientVersion.trim()) return;
    setNotice('');
    setWriteError('');
    if (drillArmed) {
      failNextReconciliationWrite();
      setDrillArmed(false);
    }
    const callerName =
      callerOptions.find((option) => option.id === callerId)?.name.replace('（未登记）', '') ??
      callerId;
    try {
      const outcome = await ingest.mutateAsync({
        contract,
        batch: [
          {
            callerId,
            callerName,
            clientVersion: clientVersion.trim(),
            environment,
            requestsPerDay: Number(requestsPerDay) || 0,
            capturedAt: new Date().toISOString(),
          },
        ],
      });
      setNotice(
        `已接入 ${outcome.result.accepted} 条快照，重算 ${outcome.result.recomputedCandidates} 个受影响候选（rev ${outcome.revision}${outcome.rebased ? '，检测到另一窗口提交并已重放' : ''}）。`,
      );
    } catch (error) {
      setWriteError(error instanceof Error ? error.message : '快照写入失败。');
    }
  }

  async function recompute() {
    if (!contract) return;
    setNotice('');
    setWriteError('');
    try {
      const outcome = await runReconciliation.mutateAsync(contract);
      setNotice(
        `已全量重算 ${outcome.result.candidates.length} 个候选（rev ${outcome.revision}${outcome.rebased ? '，检测到另一窗口提交并已重放' : ''}）。`,
      );
    } catch (error) {
      setWriteError(error instanceof Error ? error.message : '对账写入失败。');
    }
  }

  return (
    <div>
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-sky-800">
          Release Reconciliation
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-950 sm:text-3xl">上线对账</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
          把冻结版本、网关流量快照和兼容层豁免对齐：同一调用方同一版本只认最新快照，
          不兼容变化只阻挡未升级且仍有生产流量的调用方，豁免过期或差异变化即失效。
        </p>
      </div>

      {recovery && (
        <div className="mb-4 flex items-start gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-3">
          <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-700" />
          <p className="text-xs leading-5 text-slate-700">
            检测到上次写入失败，已从检查点恢复（rev {recovery.revision}，
            {formatDateTime(recovery.recoveredAt)}）。
          </p>
        </div>
      )}
      {notice && (
        <div className="mb-4 flex items-start gap-3 rounded-md border border-sky-200 bg-sky-50 p-3">
          <CheckCircle2 className="mt-0.5 h-4 w-4 text-sky-800" />
          <p className="text-xs leading-5 text-slate-700">{notice}</p>
        </div>
      )}
      {writeError && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-md border border-red-200 bg-red-50 p-3">
          <div className="flex items-start gap-3">
            <TriangleAlert className="mt-0.5 h-4 w-4 text-red-700" />
            <p className="text-xs leading-5 text-slate-700">{writeError}</p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setWriteError('');
              void reconciliation.refetch();
            }}
          >
            从检查点恢复
          </Button>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          <Card>
            <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle>对账结论</CardTitle>
                <CardDescription>
                  {contract
                    ? `${contract.name} · 目标版本 v${contract.version}${
                        contract.versions[0] ? ` · 上一冻结版本 v${contract.versions[0].version}` : ''
                      }`
                    : '先在右侧选择要对账的契约'}
                </CardDescription>
              </div>
              {contract && (
                <Badge tone={summary.blocked ? 'red' : 'green'}>
                  {summary.blocked ? `${summary.blocked} 个调用方阻挡发布` : '对账通过'}
                </Badge>
              )}
            </CardHeader>
            {contract && (
              <CardContent>
                <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 sm:grid-cols-5">
                  {(
                    [
                      ['blocked', '阻挡发布'],
                      ['exempted', '豁免放行'],
                      ['upgraded', '已升级'],
                      ['no-production-traffic', '无生产流量'],
                      ['no-snapshot', '缺少快照'],
                    ] as const
                  ).map(([status, label]) => (
                    <div key={status} className="bg-white px-3 py-3">
                      <span className="text-[11px] text-slate-500">{label}</span>
                      <strong
                        className={
                          status === 'blocked' && summary[status]
                            ? 'mt-1 block text-lg text-red-700'
                            : 'mt-1 block text-lg text-slate-900'
                        }
                      >
                        {summary[status]}
                      </strong>
                    </div>
                  ))}
                </div>
              </CardContent>
            )}
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>受影响候选</CardTitle>
              <CardDescription>
                不兼容变化 × 调用方；快照更新后只重算受影响的调用方
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[860px] text-left text-sm">
                  <thead className="bg-slate-50 text-xs text-slate-500">
                    <tr>
                      <th className="px-4 py-3 font-medium">调用方</th>
                      <th className="px-4 py-3 font-medium">登记版本</th>
                      <th className="px-4 py-3 font-medium">网关滞后版本</th>
                      <th className="px-4 py-3 font-medium">不兼容变化</th>
                      <th className="px-4 py-3 font-medium">状态</th>
                      <th className="px-4 py-3 font-medium">说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidates.map((candidate) => (
                      <tr key={candidate.id} className="border-t border-slate-100">
                        <td className="px-4 py-3">
                          <div className="font-medium text-slate-900">{candidate.callerName}</div>
                          {!candidate.registered && (
                            <Badge tone="amber" className="mt-1">
                              未登记
                            </Badge>
                          )}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-700">
                          {candidate.registryVersion || '—'}
                        </td>
                        <td className="px-4 py-3">
                          {candidate.laggingVersions.length ? (
                            candidate.laggingVersions.map((item) => (
                              <div key={item.clientVersion} className="text-xs text-slate-700">
                                <span className="font-mono">v{item.clientVersion}</span>
                                <span className="ml-2 text-slate-500">
                                  日均 {formatNumber(item.requestsPerDay)}
                                </span>
                              </div>
                            ))
                          ) : (
                            <span className="text-xs text-slate-400">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-700">
                          {candidate.changeLabel}
                        </td>
                        <td className="px-4 py-3">
                          <Badge tone={STATUS_TONES[candidate.status]}>
                            {CANDIDATE_STATUS_LABELS[candidate.status]}
                          </Badge>
                        </td>
                        <td className="max-w-xs px-4 py-3 text-xs leading-5 text-slate-600">
                          {candidate.reason}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {contract && !candidates.length && (
                  <p className="px-4 py-14 text-center text-sm text-slate-500">
                    没有不兼容变化，无需对账。
                  </p>
                )}
                {!contract && (
                  <p className="px-4 py-14 text-center text-sm text-slate-500">
                    请选择契约后查看对账候选。
                  </p>
                )}
              </div>
            </CardContent>
          </Card>

          {contract && (
            <Card>
              <CardHeader>
                <CardTitle>兼容层豁免</CardTitle>
                <CardDescription>过期或差异变化即失效，失效豁免不再放行</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {exemptions.map(({ exemption, validity }) => (
                  <div
                    key={exemption.id}
                    className="flex items-start justify-between gap-4 rounded-md border border-slate-200 px-3 py-3"
                  >
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <strong className="text-sm">{exemption.scope}</strong>
                        <Badge tone={validity.valid ? 'green' : 'red'}>
                          {validity.valid ? '有效' : '已失效'}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs leading-5 text-slate-600">
                        {exemption.reason}（{exemption.approvedBy} 批准，至 {exemption.expiresAt}）
                      </p>
                      <p className="mt-1 text-xs text-slate-500">{validity.reason}</p>
                    </div>
                    <span className="shrink-0 font-mono text-[11px] text-slate-400">
                      {exemption.diffFingerprint ?? '无指纹'}
                    </span>
                  </div>
                ))}
                {!exemptions.length && (
                  <p className="py-6 text-center text-sm text-slate-500">该契约没有登记豁免。</p>
                )}
              </CardContent>
            </Card>
          )}

          {contract && (
            <Card>
              <CardHeader>
                <CardTitle>网关流量快照</CardTitle>
                <CardDescription>
                  同一调用方同一版本只保留最新快照，当前有效 {snapshots.length} 条
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-left text-sm">
                    <thead className="bg-slate-50 text-xs text-slate-500">
                      <tr>
                        <th className="px-4 py-3 font-medium">调用方</th>
                        <th className="px-4 py-3 font-medium">客户端版本</th>
                        <th className="px-4 py-3 font-medium">环境</th>
                        <th className="px-4 py-3 font-medium">日均调用</th>
                        <th className="px-4 py-3 font-medium">采集时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshots.map((snapshot) => (
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
                          <td className="px-4 py-3 text-slate-600">
                            {formatDateTime(snapshot.capturedAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!snapshots.length && (
                    <p className="px-4 py-14 text-center text-sm text-slate-500">
                      网关尚未上报该契约的流量快照。
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>选择对账契约</CardTitle>
              <CardDescription>与版本发布页共用同一个候选</CardDescription>
            </CardHeader>
            <CardContent>
              <Select value={selectedContractId} onValueChange={setSelectedContract}>
                <SelectTrigger className="w-full">
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
              {contract && (
                <p className="mt-3 text-xs leading-5 text-slate-500">
                  发布门禁会合并这里的对账结论，
                  <Link to="/releases" className="font-medium text-sky-800 hover:underline">
                    前往版本发布
                  </Link>
                  查看冻结条件。
                </p>
              )}
            </CardContent>
          </Card>

          {contract && (
            <Card>
              <CardHeader>
                <CardTitle>接入网关快照</CardTitle>
                <CardDescription>模拟网关上报，写入后自动重算受影响候选</CardDescription>
              </CardHeader>
              <CardContent>
                <label className="block text-xs font-medium text-slate-700">调用方</label>
                <Select
                  value={callerId}
                  onValueChange={(value) => {
                    setCallerId(value);
                    const option = callerOptions.find((item) => item.id === value);
                    if (option) setClientVersion(option.version);
                  }}
                >
                  <SelectTrigger className="mt-1.5 w-full">
                    <SelectValue placeholder="选择调用方" />
                  </SelectTrigger>
                  <SelectContent>
                    {callerOptions.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <label className="mt-4 block text-xs font-medium text-slate-700">客户端版本</label>
                <Input
                  className="mt-1.5"
                  value={clientVersion}
                  onChange={(event) => setClientVersion(event.target.value)}
                  placeholder="4.8.0"
                />

                <label className="mt-4 block text-xs font-medium text-slate-700">环境</label>
                <Select
                  value={environment}
                  onValueChange={(value) => setEnvironment(value as '生产' | '预发' | '灰度')}
                >
                  <SelectTrigger className="mt-1.5 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="生产">生产</SelectItem>
                    <SelectItem value="预发">预发</SelectItem>
                    <SelectItem value="灰度">灰度</SelectItem>
                  </SelectContent>
                </Select>

                <label className="mt-4 block text-xs font-medium text-slate-700">日均调用</label>
                <Input
                  className="mt-1.5"
                  inputMode="numeric"
                  value={requestsPerDay}
                  onChange={(event) => setRequestsPerDay(event.target.value)}
                  placeholder="680000"
                />

                <Button
                  className="mt-4 w-full"
                  disabled={!callerId || !clientVersion.trim() || ingest.isPending}
                  onClick={() => void submitSnapshot()}
                >
                  <CloudUpload className="h-4 w-4" />
                  {ingest.isPending ? '写入中' : '写入快照并重算'}
                </Button>
              </CardContent>
            </Card>
          )}

          {contract && (
            <Card>
              <CardHeader>
                <CardTitle>对账记录</CardTitle>
                <CardDescription>持久化台账，受检查点与版本号保护</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-slate-600">
                <Fact icon={FileClock} label="上次对账">
                  {run ? formatDateTime(run.computedAt) : '尚未对账'}
                </Fact>
                <Fact icon={Radar} label="快照水位">
                  {run?.snapshotWatermark ? formatDateTime(run.snapshotWatermark) : '—'}
                </Fact>
                <Fact icon={ShieldCheck} label="存储版本">
                  rev {store?.revision ?? '—'}
                </Fact>
                <div className="flex gap-2 pt-1">
                  <Button
                    variant="secondary"
                    className="flex-1"
                    disabled={runReconciliation.isPending}
                    onClick={() => void recompute()}
                  >
                    <RefreshCcw className="h-4 w-4" />
                    {runReconciliation.isPending ? '重算中' : '全量重算'}
                  </Button>
                  <Button
                    variant={drillArmed ? 'danger' : 'outline'}
                    className="flex-1"
                    onClick={() => setDrillArmed((armed) => !armed)}
                  >
                    {drillArmed ? '已挂故障' : '演练写入失败'}
                  </Button>
                </div>
                {drillArmed && (
                  <p className="text-xs leading-5 text-amber-700">
                    下一次快照写入或对账提交会在主存储落盘前失败，用于验证检查点恢复。
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Fact({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof FileClock;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between border-b border-slate-100 pb-2.5 last:border-0 last:pb-0">
      <span className="flex items-center gap-2 text-slate-600">
        <Icon className="h-4 w-4 text-sky-800" />
        {label}
      </span>
      <strong className="text-slate-900">{children}</strong>
    </div>
  );
}
