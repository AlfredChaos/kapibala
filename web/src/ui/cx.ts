// classnames 极简实现：过滤 falsy 后拼接（设计系统 class 组合唯一入口）
export function cx(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ');
}
