<template>
  <section class="page" data-module="turnaround">
    <header class="page-head">
      <div>
        <h2>过站监控管理</h2>
        <p class="page-desc">维护过站记录，围绕过站编号、关联航班、过站时长、保障进度、过站状态做登记、筛选与单向状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记过站记录</button>
        <button class="btn" type="button" @click="exportRows">导出过站监控清单</button>
      </div>
    </header>

    <div v-if="showRecovery" class="ready-banner" role="alert">
      <span class="ready-reason">过站监控未就绪：{{ recoveryReason }}</span>
      <span class="ready-actions">
        <button class="btn" type="button" @click="recheckReadiness">重新检测</button>
        <button class="btn ghost" type="button" @click="recoverSeed">恢复示例数据</button>
      </span>
    </div>

    <p class="flow-legend">
      单向流转：待监测 → 监测中 → 正常完成 / 已超时。只准顺着既定环节往下一格，越过或倒走都不予受理；
      标记超时后机坪安全台账会同步巡查待办；中断后重新打开将从当前状态恢复。
    </p>

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

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <template v-if="rowActions(row).length">
              <button
                v-for="action in rowActions(row)"
                :key="action"
                class="link"
                type="button"
                @click="runAction(action, row)"
              >
                {{ action }}
              </button>
            </template>
            <span v-else class="archived-text">已归档</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无过站监控数据，可先登记过站记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条过站监控记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  moduleReadiness,
  resetModule,
  runAction as applyAction,
} from '@/api/local-service'
import { allowedActions } from '@/data/flows'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('turnaround')
const columns = ["过站编号", "关联航班", "计划到港", "实际到港", "过站时长", "保障进度", "异常事项", "过站状态"]
const statuses = ["待监测", "监测中", "正常完成", "已超时"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const loadError = ref('')
const readiness = ref({ ready: true, reason: '' })
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const stats = computed(() => [
  { label: '监测中航班', value: countStatus('监测中') },
  { label: '正常完成航班', value: countStatus('正常完成') },
  { label: '超时航班', value: countStatus('已超时') },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: countStatus(status),
  })),
)
// 未就绪（探测失败或列表读取失败）时展示原因并提供恢复入口。
const showRecovery = computed(() => !readiness.value.ready || loadError.value !== '')
const recoveryReason = computed(() =>
  readiness.value.ready ? loadError.value : readiness.value.reason,
)

function countStatus(status: string): number {
  return rows.value.filter((row) => String(row.status) === status).length
}

// 每行只提供"往下一格"的动作；终态记录已归档，不再受理任何动作。
function rowActions(row: EntryRow): string[] {
  return allowedActions(meta.key, String(row.status))
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '过站记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function recheckReadiness() {
  readiness.value = moduleReadiness(meta.key)
  reload()
}

function recoverSeed() {
  resetModule(meta.key)
  readiness.value = moduleReadiness(meta.key)
  noticeMessage.value = '已恢复示例数据，可继续按环节推进'
  errorMessage.value = ''
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    loadError.value = ''
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '过站监控列表读取失败'
  }
}

onMounted(() => {
  readiness.value = moduleReadiness(meta.key)
  reload()
})
</script>
