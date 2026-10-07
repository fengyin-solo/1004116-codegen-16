// 单向状态流转：只准顺着既定环节往下一格，越过或倒走都不予受理。
// 结构：模块 key → 当前状态 → 该状态受理的动作 → 动作后的下一状态。
// 没登记的模块仍走 local-service 里的通用流转，不受单向约束。
export const ONE_WAY_FLOWS: Record<string, Record<string, Record<string, string>>> = {
  turnaround: {
    待监测: { 开始监测: '监测中' },
    监测中: { 正常完成: '正常完成', 标记超时: '已超时' },
    正常完成: {},
    已超时: {},
  },
}

export type FlowVerdict =
  | { ok: true; target: string }
  | { ok: false; reason: string }

export function hasOneWayFlow(key: string): boolean {
  return key in ONE_WAY_FLOWS
}

// 某状态下还能执行的动作（只含"往下一格"的那些），页面按它渲染按钮。
export function allowedActions(key: string, status: string): string[] {
  const flow = ONE_WAY_FLOWS[key]
  if (!flow) {
    return []
  }
  return Object.keys(flow[status] ?? {})
}

// 终态：没有下一格可走。终态记录视为归档，保持原口径，不再受理任何动作。
export function isTerminal(key: string, status: string): boolean {
  const flow = ONE_WAY_FLOWS[key]
  if (!flow) {
    return false
  }
  const next = flow[status]
  return next !== undefined && Object.keys(next).length === 0
}

// 校验一次流转：只受理当前状态登记的动作；越过、倒走、终态重复都给出原因。
export function checkOneWay(
  key: string,
  statuses: string[],
  current: string,
  action: string,
  actionTarget: string,
): FlowVerdict {
  const flow = ONE_WAY_FLOWS[key]
  if (!flow) {
    return { ok: true, target: actionTarget }
  }
  const transitions = flow[current]
  if (!transitions) {
    return { ok: false, reason: `当前状态「${current}」不在单向流转环节内，无法受理「${action}」` }
  }
  const target = transitions[action]
  if (target) {
    return { ok: true, target }
  }
  if (Object.keys(transitions).length === 0) {
    return { ok: false, reason: `「${current}」已是终态，记录已归档，不再受理「${action}」` }
  }
  const rank = (status: string): number => {
    const index = statuses.indexOf(status)
    return index < 0 ? Number.MAX_SAFE_INTEGER : index
  }
  if (rank(actionTarget) > rank(current)) {
    const allowed = Object.entries(transitions)
      .map(([name, next]) => `「${name}」→「${next}」`)
      .join('，')
    return { ok: false, reason: `「${action}」越过了既定环节：「${current}」只受理${allowed}，请顺着环节往下一格` }
  }
  return { ok: false, reason: `状态只准单向推进，不能从「${current}」倒走回「${actionTarget}」` }
}
