import { listRows, saveMany, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, RecoverEntry } from '@/data/types'

// 过站监控单向状态机：
//   待监测 → 监测中 → 正常完成
//                     ↘ 已超时（终态）
// 只准顺着既定环节往下一格，跳格、倒走一律不予受理。
const KEY = 'turnaround'
const APRON_KEY = 'apron_safety'

export const TURN_STATUSES = ['待监测', '监测中', '正常完成', '已超时'] as const
const TERMINAL_STATUSES = ['正常完成', '已超时']
const TRACK_STATUSES = ['待监测', '监测中']

// 每个状态下唯一合法的下一格动作（监测中可落到两个并列终态，均为前进一格）。
const LEGAL_ACTIONS: Record<string, string[]> = {
  待监测: ['开始监测'],
  监测中: ['正常完成', '标记超时'],
  正常完成: [],
  已超时: [],
}

const ACTION_TARGET: Record<string, string> = {
  开始监测: '监测中',
  正常完成: '正常完成',
  标记超时: '已超时',
}

export function legalActions(status: string): string[] {
  return LEGAL_ACTIONS[status] ?? []
}

export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.includes(status)
}

export function isTrack(status: string): boolean {
  return TRACK_STATUSES.includes(status)
}

function reject(message: string, code: NonNullable<ActionResult['code']>, recover?: RecoverEntry, currentStatus?: string): ActionResult {
  return { ok: false, message, code, recover, currentStatus }
}

function nowText(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
}

function rowVersion(row: EntryRow): number {
  const value = Number(row._version)
  return Number.isFinite(value) && value > 0 ? value : 1
}

// 保障进度取前缀数字：「60%」→ 60，无法识别按 0 处理。
function progressOf(row: EntryRow): number {
  const match = String(row.保障进度 ?? '').match(/\d+/)
  return match ? Number(match[0]) : 0
}

// 过站监测就绪条件：关联航班与计划过站时长必须齐备。
function readinessIssue(action: string, row: EntryRow): string {
  if (action === '开始监测') {
    if (!String(row.关联航班 ?? '').trim()) {
      return '关联航班未登记，暂不能开始监测'
    }
    if (!String(row.过站时长 ?? '').trim()) {
      return '过站时长（计划）未维护，暂不能开始监测'
    }
  }
  if (action === '正常完成' && progressOf(row) < 100) {
    return `保障进度仅 ${progressOf(row)}%，未达到 100%，不能判定正常完成`
  }
  return ''
}

/**
 * 并发确认的统一入口。
 * expectedVersion 为页面打开时看到的版本：别的会话（另一标签页/重复提交）先落了结论，
 * 版本就会对不上，本次请求按冲突驳回，只留首份结论。
 */
export function runTurnaroundAction(
  id: number,
  action: string,
  expectedVersion?: number,
  operator = '值班管理员',
): ActionResult {
  const target = ACTION_TARGET[action]
  if (!target) {
    return reject(`过站记录没有登记「${action}」这个动作`, 'unknown-action')
  }
  const rows = listRows(KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return reject(`没有找到编号为 ${id} 的过站记录`, 'not-found')
  }
  const current = rows[index]
  const status = String(current.status)

  if (isTerminal(status)) {
    // 历史归档保持原口径：终态结论落档后冻结，任何重复确认都不再受理。
    return reject(
      `过站 ${String(current.过站编号)} 已于 ${String(current._conclusionAt ?? '此前')}「${status}」归档，结论不可变更`,
      'archived',
      undefined,
      status,
    )
  }
  if (!legalActions(status).includes(action)) {
    // 越过或倒走都不予受理：只允许推进到状态链上的下一格。
    return reject(
      `当前状态「${status}」不允许执行「${action}」，只能按 ${TURN_STATUSES.join(' → ')} 顺序推进到下一环节`,
      'illegal-transition',
      { label: '刷新到当前状态', kind: 'reload' },
      status,
    )
  }

  const version = rowVersion(current)
  if (expectedVersion !== undefined && expectedVersion !== version) {
    // 并发确认只留首份结论：后到的请求版本过期，原样驳回并引导恢复。
    return reject(
      `该过站记录已被其他会话推进（当前「${status}」），本次${action}为过期操作，首份结论已保留`,
      'conflict',
      { label: '恢复到最新状态', kind: 'reload' },
      status,
    )
  }

  // 未就绪时展示原因，并给出对应的恢复入口。
  const issue = readinessIssue(action, current)
  if (issue) {
    if (action === '开始监测') {
      return reject(
        issue,
        'not-ready',
        { label: '补齐监测准备', kind: 'prepare' },
        status,
      )
    }
    return reject(
      issue,
      'not-ready',
      { label: '推进保障进度', kind: 'progress' },
      status,
    )
  }

  const stamped = nowText()
  const updated: EntryRow = {
    ...current,
    status: target,
    过站状态: target,
    pending: !isTerminal(target),
    abnormal: target === '已超时',
    _version: version + 1,
  }

  if (action === '开始监测') {
    updated._startedAt = stamped
  }
  if (action === '正常完成') {
    updated.保障进度 = '100%'
    updated._conclusionAt = stamped
    updated._conclusionBy = operator
  }
  if (action === '标记超时') {
    updated.异常事项 = `保障超时，已于 ${stamped} 联动机坪安全巡查`
    updated._timeoutAt = stamped
    updated._conclusionAt = stamped
    updated._conclusionBy = operator
  }

  const nextRows = [...rows]
  nextRows[index] = updated

  // 超时后同步其他模块：向机坪安全台账追加巡查待办（幂等，重复超时确认不会再追加）。
  let syncedPatrolNo: string | undefined
  if (target === '已超时' && !String(updated._syncedPatrolNo ?? '').trim()) {
    const patrol = buildPatrolTodo(updated)
    updated._syncedPatrolNo = String(patrol.巡查编号)
    syncedPatrolNo = String(patrol.巡查编号)
    saveMany({ [KEY]: nextRows, [APRON_KEY]: [...listRows(APRON_KEY), patrol] })
  } else {
    saveRows(KEY, nextRows)
  }

  const message =
    target === '已超时' && syncedPatrolNo
      ? `过站 ${String(updated.过站编号)} 已标记超时，机坪安全台账已同步巡查待办 ${syncedPatrolNo}`
      : `过站 ${String(updated.过站编号)}已${action}，当前状态「${target}」`
  return { ok: true, message, currentStatus: target, syncedPatrolNo }
}

// 超时联动的机坪安全巡查待办：保持台账原字段口径，来源信息走下划线内部字段，不进归档导出。
function buildPatrolTodo(row: EntryRow): EntryRow {
  const patrolRows = listRows(APRON_KEY)
  const nextId = patrolRows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  const serial = String(nextId).padStart(4, '0')
  const today = new Date().toISOString().slice(0, 10)
  return {
    id: nextId,
    status: '待巡查',
    pending: true,
    abnormal: false,
    巡查编号: `APRO-2026-${serial}`,
    巡查区域: `过站航班 ${String(row.关联航班)} 机位（超时联动）`,
    巡查人员: '待派单',
    巡查日期: today,
    发现问题: `过站 ${String(row.过站编号)} 保障超时，待现场核查机坪安全`,
    整改措施: '待现场巡查后登记',
    复查结果: '待复查',
    安全状态: '待巡查',
    _来源: '过站超时同步',
    _过站编号: String(row.过站编号),
    _关联航班: String(row.关联航班),
    _version: 1,
  }
}

// 恢复入口：推进保障进度（每次 +20%，封顶 100%）。不改变状态，不触碰状态链。
export function bumpProgress(id: number): ActionResult {
  const rows = listRows(KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return reject(`没有找到编号为 ${id} 的过站记录`, 'not-found')
  }
  const current = rows[index]
  if (String(current.status) !== '监测中') {
    return reject(
      `仅监测中的记录可以推进保障进度，当前为「${String(current.status)}」`,
      'illegal-transition',
      { label: '刷新到当前状态', kind: 'reload' },
      String(current.status),
    )
  }
  const next = Math.min(100, progressOf(current) + 20)
  const updated: EntryRow = {
    ...current,
    保障进度: `${next}%`,
    _version: rowVersion(current) + 1,
  }
  const nextRows = [...rows]
  nextRows[index] = updated
  saveRows(KEY, nextRows)
  return {
    ok: true,
    message: next >= 100 ? '保障进度已达 100%，可以确认正常完成' : `保障进度已推进至 ${next}%`,
    currentStatus: String(updated.status),
  }
}

// 恢复入口：补齐监测准备（计划过站时长缺失时按标准 60 分钟预填）。
export function prepareMonitoring(id: number): ActionResult {
  const rows = listRows(KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return reject(`没有找到编号为 ${id} 的过站记录`, 'not-found')
  }
  const current = rows[index]
  if (String(current.status) !== '待监测') {
    return reject(
      `仅待监测的记录可以补齐准备信息，当前为「${String(current.status)}」`,
      'illegal-transition',
      { label: '刷新到当前状态', kind: 'reload' },
      String(current.status),
    )
  }
  const updated: EntryRow = {
    ...current,
    过站时长: String(current.过站时长 ?? '').trim() ? current.过站时长 : '60分钟（计划，系统预填）',
    _version: rowVersion(current) + 1,
  }
  const nextRows = [...rows]
  nextRows[index] = updated
  saveRows(KEY, nextRows)
  return { ok: true, message: '监测准备已补齐，可重新执行开始监测', currentStatus: '待监测' }
}

// 中断恢复：返回仍处监测中的记录，页面据此提示从当前状态继续。
export function resumableTurnarounds(): EntryRow[] {
  return listRows(KEY).filter((row) => String(row.status) === '监测中')
}
