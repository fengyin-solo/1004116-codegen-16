<template>
  <section class="page" data-module="turnaround">
    <header class="page-head">
      <div>
        <h2>过站监控管理</h2>
        <p class="page-desc">
          单向状态流转：待监测 → 监测中 → 正常完成 / 已超时，只准逐格前进；超时自动联动机坪安全巡查待办。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记过站记录</button>
        <button class="btn" type="button" @click="exportRows">导出过站监控清单</button>
      </div>
    </header>

    <!-- 中断恢复：刷新或重开页面后，监测中的记录从当前状态继续 -->
    <div v-if="resumeInfo" class="notice-banner resume">
      <span>
        检测到 {{ resumeInfo.count }} 条过站仍在监测中（{{ resumeInfo.ids }}），已从当前状态恢复，可继续推进。
      </span>
      <button class="btn mini" type="button" @click="scrollToMonitoring">定位监测中记录</button>
      <button class="btn mini ghost" type="button" @click="dismissResume">知道了</button>
    </div>

    <!-- 并发/跨标签页变更：数据被其他会话改动时提示恢复入口 -->
    <div v-if="externalNotice" class="notice-banner external">
      <span>{{ externalNotice }}</span>
      <button class="btn mini primary" type="button" @click="handleReload">恢复到最新状态</button>
    </div>

    <!-- 操作结论：成功（含超时联动结果）或驳回原因与恢复入口 -->
    <div v-if="banner" :class="['notice-banner', banner.ok ? 'success' : 'reject']" role="alert">
      <span>{{ banner.message }}</span>
      <button
        v-if="banner.recover"
        class="btn mini"
        :class="banner.recover.kind === 'apron-ledger' ? 'primary' : ''"
        type="button"
        @click="handleRecover(banner.recover.kind, bannerRowId)"
      >
        {{ banner.recover.label }}
      </button>
      <button class="btn mini ghost" type="button" @click="banner = null">关闭</button>
    </div>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload()">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <label class="filter-item">
        <span>过站状态</span>
        <select v-model="statusFilter">
          <option value="">全部状态</option>
          <option v-for="status in statuses" :key="status" :value="status">{{ status }}</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>状态流转链</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-monitoring': row.status === '监测中' }">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>
            <div class="state-chain">
              <span class="chain-node" :class="chainClass(row.status, '待监测')">待监测</span>
              <span class="chain-arrow">→</span>
              <span class="chain-node" :class="chainClass(row.status, '监测中')">监测中</span>
              <span class="chain-arrow">→</span>
              <span class="chain-branch">
                <span
                  :class="['chain-node', chainClass(row.status, '正常完成'), row.status === '正常完成' ? 'branch-done' : '']"
                >正常完成</span>
                <span class="branch-slash">/</span>
                <span
                  :class="['chain-node', chainClass(row.status, '已超时'), row.status === '已超时' ? 'branch-timeout' : '']"
                >已超时</span>
              </span>
            </div>
            <span v-if="isTerminalRow(row.status)" class="archived-tag">
              已归档 · {{ String(row._conclusionBy || '值班管理员') }} {{ String(row._conclusionAt || '') }}
            </span>
          </td>
          <td>
            <span :class="['status-pill', `status-${statusClass(row.status)}`]">{{ row.status }}</span>
            <span v-if="row.status === '已超时' && row._syncedPatrolNo" class="sync-hint">
              已联动 {{ String(row._syncedPatrolNo) }}
            </span>
          </td>
          <td class="row-actions">
            <template v-if="legalActionsFor(row.status).length">
              <button
                v-for="action in legalActionsFor(row.status)"
                :key="action"
                class="link"
                type="button"
                :disabled="busyId === String(row.id)"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </template>
            <span v-else class="muted-text">无下一环节</span>

            <!-- 未就绪原因与恢复入口（最近一次驳回挂在对应行上） -->
            <div v-if="rowFeedback[row.id]" class="inline-feedback">
              <span class="feedback-reason">{{ rowFeedback[row.id].message }}</span>
              <button
                v-if="rowFeedback[row.id].recover"
                class="link recover-link"
                type="button"
                @click="handleRecover(rowFeedback[row.id].recover!.kind, row.id)"
              >
                {{ rowFeedback[row.id].recover!.label }}
              </button>
              <button class="link muted-link" type="button" @click="clearFeedback(row.id)">忽略</button>
            </div>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无符合条件的过站监控记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条过站监控记录；终态记录保持历史归档口径，不可倒走、不可改判。</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'

import {
  bumpProgress,
  isTerminal as isTerminalStatus,
  legalActions,
  prepareMonitoring,
  resumableTurnarounds,
  runTurnaroundAction,
  TURN_STATUSES,
} from '@/api/turnaround-service'
import {
  downloadEntries,
  listEntries,
  moduleMeta,
} from '@/api/local-service'
import { subscribeStoreChanges } from '@/data/local-store'
import type { ActionResult, EntryRow, RecoverKind } from '@/data/types'

const router = useRouter()
const meta = moduleMeta('turnaround')
const columns = ['过站编号', '关联航班', '计划到港', '实际到港', '过站时长', '保障进度', '异常事项']
const statuses = [...TURN_STATUSES]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const statusFilter = ref('')
const filterFields = ['过站编号', '关联航班', '计划到港']
const busyId = ref<string | null>(null)

// 顶部结论横幅（最近一次动作）与按行挂载的未就绪提示。
const banner = ref<(ActionResult & { ok: boolean }) | null>(null)
const bannerRowId = ref<number | null>(null)
const rowFeedback = reactive<Record<number, ActionResult>>({})

const resumeInfo = ref<{ count: number; ids: string } | null>(null)
const resumeDismissed = ref(false)
const externalNotice = ref('')
let unsubscribe: (() => void) | null = null

const stats = computed(() => [
  { label: '待监测航班', value: countByStatus('待监测') },
  { label: '监测中航班', value: countByStatus('监测中') },
  { label: '正常完成航班', value: countByStatus('正常完成') },
  { label: '超时航班', value: countByStatus('已超时') },
])

const statusSummary = computed(() =>
  statuses.map((status) => ({ status, count: countByStatus(status) })),
)

function countByStatus(status: string): number {
  return rows.value.filter((row) => String(row.status) === status).length
}

function legalActionsFor(status: string): string[] {
  return legalActions(status)
}

function isTerminalRow(status: string): boolean {
  return isTerminalStatus(status)
}

// 状态链：待监测 → 监测中 →（正常完成 / 已超时），监测中之后两个终态是并列分支。
function chainClass(currentStatus: string, node: string): 'done' | 'current' | 'idle' {
  const order = ['待监测', '监测中', '正常完成', '已超时']
  const currentIndex = order.indexOf(currentStatus)
  const nodeIndex = order.indexOf(node)
  if (nodeIndex < currentIndex) {
    return 'done'
  }
  if (nodeIndex === currentIndex) {
    return 'current'
  }
  // 监测中：两个终态都是下一格候选；已超时时「正常完成」保持未点亮。
  if (currentStatus === '监测中' && nodeIndex === 2) {
    return 'idle'
  }
  return 'idle'
}

function statusClass(status: string): string {
  if (status === '待监测') return 'pending'
  if (status === '监测中') return 'tracking'
  if (status === '正常完成') return 'done'
  return 'timeout'
}

function resetFilters() {
  filters.value = {}
  statusFilter.value = ''
  reload()
}

function exportRows() {
  // 历史归档保持原口径：导出只含业务字段与当前状态，_版本/_结论 等内部控制字段不落档。
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '过站记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  banner.value = null
  delete rowFeedback[Number(row.id)]
  busyId.value = String(row.id)
  try {
    const expectedVersion = Number(row._version)
    const result = runTurnaroundAction(Number(row.id), action, expectedVersion)
    handleResult(result, Number(row.id))
  } finally {
    busyId.value = null
  }
}

function handleResult(result: ActionResult, rowId: number) {
  if (result.ok) {
    banner.value = { ...result, ok: true }
    bannerRowId.value = rowId
    reload({ keepBanner: true })
    if (result.syncedPatrolNo) {
      banner.value = {
        ...banner.value,
        recover: { label: '前往机坪安全台账', kind: 'apron-ledger' },
      }
    }
    return
  }
  // 未就绪/归档/冲突：在行内展示原因并提供恢复入口，同时顶部汇总。
  rowFeedback[rowId] = result
  banner.value = { ...result, ok: false }
  bannerRowId.value = rowId
  if (result.code === 'conflict') {
    reload({ silent: true })
  }
}

function handleRecover(kind: RecoverKind, rowId: number | null) {
  if (kind === 'reload') {
    handleReload()
    return
  }
  if (kind === 'apron-ledger') {
    router.push('/apron_safety')
    return
  }
  if (rowId === null) {
    return
  }
  if (kind === 'progress') {
    const result = bumpProgress(rowId)
    applyRecoverResult(result, rowId)
    return
  }
  if (kind === 'prepare') {
    const result = prepareMonitoring(rowId)
    applyRecoverResult(result, rowId)
  }
}

function applyRecoverResult(result: ActionResult, rowId: number) {
  banner.value = { ...result, ok: result.ok }
  bannerRowId.value = rowId
  if (result.ok) {
    delete rowFeedback[rowId]
    reload({ keepBanner: true })
  } else {
    rowFeedback[rowId] = result
  }
}

function clearFeedback(rowId: number) {
  delete rowFeedback[rowId]
}

function handleReload() {
  externalNotice.value = ''
  banner.value = null
  reload()
}

function scrollToMonitoring() {
  const el = document.querySelector('.row-monitoring')
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}

function dismissResume() {
  resumeDismissed.value = true
  resumeInfo.value = null
}

function checkResumable() {
  if (resumeDismissed.value) {
    return
  }
  const tracking = resumableTurnarounds()
  resumeInfo.value = tracking.length
    ? { count: tracking.length, ids: tracking.map((row) => String(row.过站编号)).join('、') }
    : null
}

function reload(options: { keepBanner?: boolean; silent?: boolean } = {}) {
  if (!options.keepBanner) {
    errorMessage.value = ''
  }
  try {
    const merged = { ...filters.value }
    const payload = listEntries(meta.key, merged)
    let items = payload.items
    if (statusFilter.value) {
      items = items.filter((row) => String(row.status) === statusFilter.value)
    }
    rows.value = items
    total.value = items.length
    checkResumable()
  } catch (error) {
    if (!options.silent) {
      errorMessage.value = error instanceof Error ? error.message : '过站监控列表读取失败'
    }
  }
}

onMounted(() => {
  reload()
  // 其他标签页先落了结论时，本页提示并提供恢复入口（并发确认只留首份结论）。
  unsubscribe = subscribeStoreChanges((key) => {
    if (key === null || key === 'turnaround' || key === 'apron_safety') {
      externalNotice.value = '过站数据已被其他页面/会话更新，当前画面可能不是最新状态'
      reload({ silent: true })
    }
  })
})

onBeforeUnmount(() => {
  unsubscribe?.()
})
</script>
