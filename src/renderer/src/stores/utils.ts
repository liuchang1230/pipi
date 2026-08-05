// Shared functional-update helper used by the store setters. Both
// sessionsStore and treeStore previously copy-pasted this — the duplication
// is folded here so the setter contract lives in one place.
export type Updater<T> = T | ((prev: T) => T);

export function apply<T>(prev: T, value: Updater<T>): T {
  return typeof value === "function" ? (value as (p: T) => T)(prev) : value;
}
