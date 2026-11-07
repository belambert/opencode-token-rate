import type { ModelInfo, SessionMessageInfo } from "@opencode/client"

/** Decode throughput of one completed assistant step. */
export type Sample = { id: string; end: number; tokens: number; ms: number }

export type Speed = { label: string; tps?: number }

/** Per-million-token prices in USD. */
export type Price = { input: number; cached: number; write: number; output: number }

/** USD spent per category, plus the host-recorded total. */
export type Spend = Price & { billed: number }

export type ModelRef = { providerID: string; id: string }

// shorter steps yield noisy, inflated rates
const MIN_MS = 250

/** Speeds for the last step, each trailing window in minutes, and the whole session. */
export function speeds(list: Sample[], minutes: readonly number[], now: number): Speed[] {
  const last = list.at(-1)
  return [
    { label: "last", tps: last && rate([last]) },
    ...minutes.map((m) => ({ label: span(m), tps: rate(list, now - m * 60_000) })),
    { label: "session", tps: rate(list) },
  ]
}

/** Token-weighted tokens/sec over samples that ended at or after `since`. */
export function rate(list: Sample[], since = -Infinity): number | undefined {
  let tokens = 0
  let ms = 0
  for (const s of list.filter((s) => s.end >= since)) {
    tokens += s.tokens
    ms += s.ms
  }
  return ms > 0 ? (tokens / ms) * 1000 : undefined
}

/** Deduplicates messages by id; later entries win. */
export const unique = (msgs: readonly SessionMessageInfo[]) => [
  ...new Map(msgs.map((m) => [m.id, m])).values(),
]

/** Samples oldest first; `firsts` maps message ids to live first-token times. */
export function samples(
  msgs: readonly SessionMessageInfo[],
  firsts?: ReadonlyMap<string, number>,
): Sample[] {
  return msgs.flatMap((msg) => sample(msg, firsts?.get(msg.id)) ?? []).sort((a, b) => a.end - b.end)
}

/**
 * USD spent per token category, pricing each message at its own model's base tier.
 *
 * `input` excludes cache reads, and reasoning bills as output. `billed` sums the host's recorded
 * message costs, so a mismatch reveals tiered pricing or models missing from the catalog.
 */
export function spend(
  msgs: readonly SessionMessageInfo[],
  models: readonly ModelInfo[] | undefined,
): Spend {
  const s = { input: 0, cached: 0, write: 0, output: 0, billed: 0 }
  for (const msg of msgs) {
    if (msg.type !== "assistant" || !msg.tokens) continue
    s.billed += msg.cost ?? 0

    const model = findModel(models, msg.model)
    const p = model && price(model)
    if (!p) continue
    const t = msg.tokens
    s.input += (t.input * p.input) / 1e6
    s.cached += (t.cache.read * p.cached) / 1e6
    s.write += (t.cache.write * p.write) / 1e6
    s.output += ((t.output + t.reasoning) * p.output) / 1e6
  }
  return s
}

export const total = (p: Price) => p.input + p.cached + p.write + p.output

// tolerate float drift and sub-cent rounding in recorded costs
const MATCH_TOLERANCE = 0.02

export const matches = (s: Spend) =>
  s.billed === 0 || Math.abs(total(s) - s.billed) <= s.billed * MATCH_TOLERANCE

/**
 * Times generation from the first streamed part to the end of the stream.
 *
 * `time.streamed` marks the stream's end; tool execution follows it. Text parts carry no timestamp,
 * so text-only messages without a live `first` fall back to `time.created`, which includes TTFT.
 */
export function sample(msg: SessionMessageInfo, first?: number): Sample | undefined {
  if (msg.type !== "assistant" || !msg.tokens || msg.time.streamed === undefined) return

  const parts = msg.content.map((c) => ("time" in c ? (c.time?.created ?? Infinity) : Infinity))
  const start = Math.min(first ?? Infinity, ...parts)
  const ms = msg.time.streamed - (Number.isFinite(start) ? start : msg.time.created)
  const tokens = msg.tokens.output + msg.tokens.reasoning
  if (ms < MIN_MS || tokens <= 0) return
  return { id: msg.id, end: msg.time.streamed, tokens, ms }
}

export function findModel(models: readonly ModelInfo[] | undefined, ref: ModelRef) {
  return models?.find(
    (m) => m.providerID === ref.providerID && (m.id === ref.id || m.modelID === ref.id),
  )
}

/** Base-tier price; context-size tiers are ignored. */
export function price(model: ModelInfo): Price | undefined {
  const c = model.cost.find((c) => !c.tier) ?? model.cost[0]
  return c && { input: c.input, cached: c.cache.read, write: c.cache.write, output: c.output }
}

export function fmtRate(tps?: number) {
  if (tps === undefined) return "—"
  return `${tps < 10 ? tps.toFixed(1) : Math.round(tps)} tok/s`
}

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 3,
})

export const fmtPrice = (n: number) => `${usd.format(n)}/M`

const cents = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

export const fmtUSD = (n: number) => (n > 0 && n < 0.01 ? "<$0.01" : cents.format(n))

const span = (m: number) => (m % 60 === 0 ? `${m / 60}h` : `${m}m`)
