// Numbers and ids both the mock source and the server must agree on.

/** The activity feed keeps this many rows (oldest dropped). */
export const MAX_ACTIVITY = 100

/** The manager's own edit protects a task / member from demo (bot) edits for this long (ms). */
export const TOUCH_WINDOW_MS = 120_000

/**
 * Id prefix of tasks created by the demo (the mock demo, or any bot request carrying X-Actor). Ids are
 * built as `${DEMO_TASK_PREFIX}_<random>` (so "td_ab12cd"); only these are ever pruned automatically.
 */
export const DEMO_TASK_PREFIX = 'td'

export const isDemoTaskId = (id: string): boolean => id.startsWith(`${DEMO_TASK_PREFIX}_`)
