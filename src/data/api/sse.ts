// Minimal Server-Sent Events reader over fetch (works in browsers and Node, can send headers).

export interface SseEvent {
  id?: string
  event: string
  data: string
}

/** Splits a text stream into SSE events. Comment lines (": ping") are reported via onComment. */
export function createSseParser(onEvent: (e: SseEvent) => void, onComment?: () => void) {
  let buffer = ''
  const flushBlock = (block: string) => {
    let id: string | undefined
    let event = 'message'
    const data: string[] = []
    let any = false
    for (const rawLine of block.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (line === '') continue
      if (line.startsWith(':')) {
        onComment?.()
        continue
      }
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'id') {
        id = value
        any = true
      } else if (field === 'event') {
        event = value
        any = true
      } else if (field === 'data') {
        data.push(value)
        any = true
      }
    }
    if (any) onEvent({ id, event, data: data.join('\n') })
  }
  return {
    push(chunk: string) {
      buffer += chunk
      for (;;) {
        const m = /\r?\n\r?\n/.exec(buffer)
        if (!m) break
        const block = buffer.slice(0, m.index)
        buffer = buffer.slice(m.index + m[0].length)
        flushBlock(block)
      }
    },
  }
}
