import type { TrafficSnapshot } from '../models/reconciliation';

/**
 * 网关上报的调用方流量快照。覆盖对账需要的典型场景：
 * - 同一调用方同一版本多条快照（只认最新）
 * - 登记版本领先网关在跑版本（未升级）
 * - 旧版本流量已排空（有快照但无生产流量）
 * - 未登记调用方仍在生产调用
 */
export const seedTrafficSnapshots: TrafficSnapshot[] = [
  // 订单履约 API：订单中心旧版本已排空，新版本承接流量
  {
    id: 'snap-order-app-462-stale',
    contractId: 'contract-order',
    callerId: 'consumer-app',
    callerName: '订单中心',
    clientVersion: '4.6.2',
    environment: '生产',
    requestsPerDay: 4800000,
    capturedAt: '2026-09-28T02:00:00.000Z',
  },
  {
    id: 'snap-order-app-462-drained',
    contractId: 'contract-order',
    callerId: 'consumer-app',
    callerName: '订单中心',
    clientVersion: '4.6.2',
    environment: '生产',
    requestsPerDay: 0,
    capturedAt: '2026-10-04T02:00:00.000Z',
  },
  {
    id: 'snap-order-app-480',
    contractId: 'contract-order',
    callerId: 'consumer-app',
    callerName: '订单中心',
    clientVersion: '4.8.0',
    environment: '生产',
    requestsPerDay: 4900000,
    capturedAt: '2026-10-04T02:05:00.000Z',
  },
  // 订单履约 API：客服工作台登记 3.9.5，网关仍在跑 3.9.0
  {
    id: 'snap-order-cs-390',
    contractId: 'contract-order',
    callerId: 'consumer-cs',
    callerName: '客服工作台',
    clientVersion: '3.9.0',
    environment: '生产',
    requestsPerDay: 680000,
    capturedAt: '2026-10-04T03:00:00.000Z',
  },
  // 订单履约 API：经营分析只有预发流量
  {
    id: 'snap-order-bi-215',
    contractId: 'contract-order',
    callerId: 'consumer-bi',
    callerName: '经营分析',
    clientVersion: '2.1.5',
    environment: '预发',
    requestsPerDay: 220000,
    capturedAt: '2026-10-04T03:10:00.000Z',
  },
  // 支付清算 API：登记调用方与网关一致
  {
    id: 'snap-pay-finance-520',
    contractId: 'contract-payment',
    callerId: 'consumer-finance',
    callerName: '财务对账',
    clientVersion: '5.2.0',
    environment: '生产',
    requestsPerDay: 1100000,
    capturedAt: '2026-10-04T01:00:00.000Z',
  },
  {
    id: 'snap-pay-ops-418',
    contractId: 'contract-payment',
    callerId: 'consumer-pay-ops',
    callerName: '支付运营台',
    clientVersion: '4.1.8',
    environment: '生产',
    requestsPerDay: 320000,
    capturedAt: '2026-10-04T01:05:00.000Z',
  },
  // 支付清算 API：未登记的遗留调用方仍有生产流量
  {
    id: 'snap-pay-legacy-300',
    contractId: 'contract-payment',
    callerId: 'caller-legacy-report',
    callerName: '遗留报表平台',
    clientVersion: '3.0.0',
    environment: '生产',
    requestsPerDay: 90000,
    capturedAt: '2026-10-04T01:20:00.000Z',
  },
  // 用户权限 API
  {
    id: 'snap-user-admin-1123',
    contractId: 'contract-user',
    callerId: 'consumer-admin',
    callerName: '权限管理台',
    clientVersion: '1.12.3',
    environment: '生产',
    requestsPerDay: 180000,
    capturedAt: '2026-10-03T09:00:00.000Z',
  },
];
