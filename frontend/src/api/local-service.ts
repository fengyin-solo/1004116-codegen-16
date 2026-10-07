import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, freshRows, listRows, resetRows, saveRows, storageKey } from '@/data/local-store'
import { checkOneWay, hasOneWayFlow, isTerminal } from '@/data/flows'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const actionTarget = meta.actionTargets[action]
  if (!actionTarget) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  // 并发确认只留首份结论：写动作一律以存储里的最新状态为准，不用页面手里的旧快照。
  const rows = freshRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === actionTarget) {
    return { ok: false, message: `${meta.entity}已经是「${actionTarget}」，首份结论已生效，重复确认不予受理` }
  }
  // 单向流转校验：只准顺着既定环节往下一格，越过或倒走都不予受理。
  const verdict = checkOneWay(key, meta.statuses, current, action, actionTarget)
  if (!verdict.ok) {
    return { ok: false, message: verdict.reason }
  }
  const target = verdict.target
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const oneWay = hasOneWayFlow(key)
  const terminal = oneWay ? isTerminal(key, target) : target === lastStatus
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: !terminal,
    abnormal: oneWay
      ? target === lastStatus || NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb))
      : NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  const extra = runSideEffects(key, target, updated)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」${extra}` }
}

// 跨模块联动：某模块进入某状态时，要同步别的模块。键：模块 key → 状态 → 处理函数。
const STATUS_SIDE_EFFECTS: Record<string, Record<string, (row: EntryRow) => string>> = {
  turnaround: {
    // 过站超时后，机坪安全台账要同步一条巡查待办。
    已超时: (row) => syncApronInspection(row),
  },
}

function runSideEffects(key: string, target: string, row: EntryRow): string {
  const effect = STATUS_SIDE_EFFECTS[key]?.[target]
  return effect ? effect(row) : ''
}

// 过站超时 → 机坪安全同步巡查待办。巡查编号带过站编号，天然可溯源、可去重。
function syncApronInspection(turn: EntryRow): string {
  const turnNo = String(turn['过站编号'] ?? `TURN-${turn.id}`)
  const patrolNo = `APRO-${turnNo}`
  const rows = freshRows('apron_safety')
  if (rows.some((row) => String(row['巡查编号']) === patrolNo)) {
    return '；机坪安全台账已有对应巡查待办，未重复登记'
  }
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const flight = String(turn['关联航班'] ?? '—')
  const inspection: EntryRow = {
    id: nextId,
    status: '待巡查',
    pending: true,
    abnormal: false,
    巡查编号: patrolNo,
    巡查区域: `过站机位（航班 ${flight}）`,
    巡查人员: '待指派',
    巡查日期: new Date().toISOString().slice(0, 10),
    发现问题: `过站超时：${turnNo}，关联航班 ${flight}，过站时长 ${turn['过站时长'] ?? '—'}`,
    整改措施: '待巡查后登记',
    复查结果: '待复查',
    安全状态: '待巡查',
  }
  saveRows('apron_safety', [...rows, inspection])
  return `；已同步机坪安全巡查待办「${patrolNo}」`
}

export type Readiness = { ready: boolean; reason: string }

// 进入页面前先探一次：模块没登记、本地存储不可用或不可写都算未就绪，
// 页面要展示原因并提供恢复入口。
export function moduleReadiness(key: string): Readiness {
  try {
    moduleMeta(key)
  } catch (error) {
    return { ready: false, reason: error instanceof Error ? error.message : `模块 ${key} 未登记` }
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    return { ready: false, reason: '当前浏览器环境没有本地存储，业务数据无法读写' }
  }
  try {
    const probeKey = `${storageKey()}:probe`
    window.localStorage.setItem(probeKey, '1')
    window.localStorage.removeItem(probeKey)
  } catch {
    return { ready: false, reason: '本地存储写入失败（可能已满或被禁用），状态流转结果不会被保存' }
  }
  return { ready: true, reason: '' }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
