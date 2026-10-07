// Pure member rules shared by the mock source and the server.
import type { Member } from '../types'
import type { CleanMemberPatch } from './validate'

export interface MemberPatchResult {
  /** The member after the patch (a copy). */
  next: Member
  /** Keys whose value differs. Empty = a no-op: write and emit nothing. */
  changed: (keyof Member)[]
  /** Only `presence` changed: the feed says "{name} 님이 …" instead of "정보를 수정했어요". */
  onlyPresence: boolean
}

/** Applies a validated patch (only given fields). */
export function applyMemberPatch(member: Member, patch: CleanMemberPatch): MemberPatchResult {
  const changed = (Object.keys(patch) as (keyof CleanMemberPatch)[]).filter((k) => patch[k] !== member[k])
  const onlyPresence = changed.length === 1 && changed[0] === 'presence'
  return { next: changed.length === 0 ? { ...member } : { ...member, ...patch }, changed, onlyPresence }
}
