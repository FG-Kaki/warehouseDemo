// Server-Sent Events hub: numbers every Change, keeps the last 1000 for Last-Event-ID replay,
// falls back to a snapshot when the client is too far behind, and pings every 10 s.
// Sequence numbers are reserved by the repo inside the mutation's transaction; the hub only broadcasts.
import type { Change, Workspace } from '../../src/data/types.ts'

export interface HubOptions {
  /** Last sequence number used before this process started (kept in the DB so ids never go backwards). */
  startSeq: number
  snapshot: () => Workspace
  ringSize?: number
  pingMs?: number
}

interface Client {
  write(text: string): void
  end(): void
}

const encoder = new TextEncoder()
const frame = (change: Change, seq: number) => `id: ${seq}\nevent: change\ndata: ${JSON.stringify(change)}\n\n`

export function createHub(opts: HubOptions) {
  const ringSize = opts.ringSize ?? 1000
  let seq = opts.startSeq
  const ring: { seq: number; change: Change }[] = []
  const clients = new Set<Client>()

  const ping = setInterval(() => broadcastRaw(': ping\n\n'), opts.pingMs ?? 10_000)
  ping.unref()

  function broadcastRaw(text: string) {
    for (const c of [...clients]) {
      try {
        c.write(text)
      } catch {
        clients.delete(c)
      }
    }
  }

  /** Call after a commit with the changes and the seq the repo gave each one. Never throws. */
  function publish(entries: { seq: number; change: Change }[]) {
    for (const e of entries) {
      if (e.seq <= seq) continue
      seq = e.seq
      ring.push(e)
      if (ring.length > ringSize) ring.shift()
      broadcastRaw(frame(e.change, e.seq))
    }
  }

  /** The SSE response for GET /api/events. */
  function connect(lastEventId: string | null): Response {
    let client: Client
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        client = {
          write: (text) => controller.enqueue(encoder.encode(text)),
          end: () => {
            try {
              controller.close()
            } catch {
              /* already closed */
            }
          },
        }
        client.write(`event: hello\ndata: ${JSON.stringify({ seq })}\n\n`)
        const last = lastEventId === null || lastEventId.trim() === '' ? NaN : Number(lastEventId)
        if (Number.isInteger(last)) {
          const oldest = ring.length > 0 ? ring[0].seq : seq + 1
          if (last > seq || last < oldest - 1) {
            // Too old (or from a previous run): one snapshot, then live changes continue from `seq`.
            client.write(frame({ type: 'snapshot', workspace: opts.snapshot() }, seq))
          } else {
            for (const r of ring) if (r.seq > last) client.write(frame(r.change, r.seq))
          }
        }
        clients.add(client)
      },
      cancel() {
        clients.delete(client)
      },
    })
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    })
  }

  return {
    get seq() {
      return seq
    },
    publish,
    connect,
    /** Ends every open stream and stops the heartbeat. */
    close() {
      clearInterval(ping)
      for (const c of [...clients]) c.end()
      clients.clear()
    },
  }
}

export type Hub = ReturnType<typeof createHub>
