import { SCHEMA_VERSION, SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// 版本号变化（如种子数据结构升级）才重新播种，日常改动保留用户数据。
const STORAGE_KEY = 'airport-ground-handling:entries'
const VERSION_KEY = 'airport-ground-handling:schema-version'
// 同一页面内的自定义事件：本标签页写入时通知视图重新读取。
const CHANGE_EVENT = 'airport-ground-handling:storage-change'

export type StoreChangeListener = (key: string | null) => void
const listeners = new Set<StoreChangeListener>()

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function writeStorage(rows: Record<string, EntryRow[]>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rows))
    window.localStorage.setItem(VERSION_KEY, String(SCHEMA_VERSION))
  }
}

function seedStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  writeStorage(fallback)
  return fallback
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  const version = window.localStorage.getItem(VERSION_KEY)
  if (!raw || version !== String(SCHEMA_VERSION)) {
    // 结构升级或首次打开：重新播种，中断过的会话以种子里的当前状态重新开始。
    return seedStorage()
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    // 后续新增的模块种子也要补进来，已存在模块的用户改动原样保留。
    return { ...fallback, ...parsed }
  } catch {
    return seedStorage()
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  writeStorage(next)
  emitChange(key)
}

// 一次事务写多个模块（如过站超时联动机坪安全台账），保证两边同落盘。
export function saveMany(patch: Record<string, EntryRow[]>): void {
  const next = { ...allRows(), ...patch }
  cache = next
  writeStorage(next)
  emitChange(null)
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

function emitChange(key: string | null): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { key } }))
  }
}

// 视图订阅数据变化：同一标签页内的写入走自定义事件，
// 另一个标签页/窗口的写入走原生 storage 事件（中断恢复与并发确认都靠它拿到最新口径）。
export function subscribeStoreChanges(listener: StoreChangeListener): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    window.addEventListener(CHANGE_EVENT, handleInternalEvent)
    window.addEventListener('storage', handleNativeStorage)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      window.removeEventListener(CHANGE_EVENT, handleInternalEvent)
      window.removeEventListener('storage', handleNativeStorage)
    }
  }
}

function handleInternalEvent(event: Event): void {
  const detail = (event as CustomEvent<{ key: string | null }>).detail
  notify(detail?.key ?? null)
}

function handleNativeStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY) {
    return
  }
  cache = null // 磁盘已被其他标签页改动，丢弃内存缓存，下次读取重新加载
  notify(null)
}

function notify(key: string | null): void {
  listeners.forEach((listener) => listener(key))
}
