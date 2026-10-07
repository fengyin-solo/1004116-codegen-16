/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

// 未就绪/冲突时提供的恢复入口：kind 由页面映射成具体按钮行为。
export type RecoverKind = 'reload' | 'recheck' | 'progress' | 'prepare' | 'apron-ledger'

export type RecoverEntry = {
  label: string
  kind: RecoverKind
}

export type ActionCode =
  | 'not-found'
  | 'unknown-action'
  | 'illegal-transition'
  | 'archived'
  | 'conflict'
  | 'not-ready'

export type ActionResult = {
  ok: boolean
  message: string
  code?: ActionCode
  currentStatus?: string
  recover?: RecoverEntry
  syncedPatrolNo?: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
