// Small Korean text helpers for activity messages (particles depend on the last syllable).

const DIGIT_BATCHIM = '013678' // 영 일 삼 육 칠 팔 end in a consonant; 이 사 오 구 do not

/** true when the word's last pronounced syllable ends in a consonant (받침). */
function hasBatchim(word: string): boolean {
  for (let i = word.length - 1; i >= 0; i--) {
    const ch = word[i]
    const code = ch.charCodeAt(0)
    if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0
    if (ch >= '0' && ch <= '9') return DIGIT_BATCHIM.includes(ch)
    if (/[a-zA-Z]/.test(ch)) {
      const tail = word.slice(0, i + 1).toLowerCase()
      return /(l|m|n|ng)$/.test(tail)
    }
    // skip quotes, brackets, punctuation, spaces
  }
  return false
}

export const eul = (word: string) => (hasBatchim(word) ? '을' : '를')
export const iGa = (word: string) => (hasBatchim(word) ? '이' : '가')

/** Shortens a task title for use inside a one-line message. */
export function shortTitle(title: string, max = 22): string {
  const t = title.trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** "WEB-12 '로그인 개선'" */
export function taskText(ref: string, title: string): string {
  return `${ref} '${shortTitle(title)}'`
}

/** "WEB-12 '로그인 개선'을" (particle follows the title). */
export function taskObject(ref: string, title: string): string {
  const t = shortTitle(title)
  return `${ref} '${t}'${eul(t)}`
}

/** "WEB-12을" (particle follows the key, e.g. "OPS-8을", "APP-35를"). */
export function refObject(ref: string): string {
  return `${ref}${eul(ref)}`
}

export function refSubject(ref: string): string {
  return `${ref}${iGa(ref)}`
}

export const STATUS_TO: Record<string, string> = {
  todo: '할 일로',
  in_progress: '진행 중으로',
  review: '검토로',
  done: '완료로',
}
