import type { ModelInfo, SessionMessageInfo } from "@opencode/client"
import { describe, expect, test } from "bun:test"
import {
  findModel,
  fmtPrice,
  fmtRate,
  fmtUSD,
  matches,
  price,
  rate,
  sample,
  samples,
  speeds,
  spend,
  total,
  unique,
} from "../src/stats"

// a step whose first timed part starts at `start` and whose stream ends at `end`, followed by tool time
const msg = (id: string, start: number, end: number, output: number, reasoning = 0) =>
  ({
    id,
    type: "assistant",
    time: { created: start - 500, streamed: end, completed: end + 5000 },
    content: [{ type: "reasoning", time: { created: start } }, { type: "text" }],
    tokens: { input: 10, output, reasoning, cache: { read: 0, write: 0 } },
  }) as unknown as SessionMessageInfo

const model = (cost: unknown[]) =>
  ({ id: "m", modelID: "m-raw", providerID: "p", name: "M", cost }) as unknown as ModelInfo

const tier = (input: number, output: number, read: number, write: number, size?: number) => ({
  ...(size && { tier: { type: "context", size } }),
  input,
  output,
  cache: { read, write },
})

describe("sample", () => {
  test("counts output and reasoning from first part to stream end", () => {
    expect(sample(msg("a", 1000, 3000, 80, 20))).toEqual({
      id: "a",
      end: 3000,
      tokens: 100,
      ms: 2000,
    })
  })

  test("prefers an earlier live first-token time", () => {
    expect(sample(msg("a", 1000, 3000, 100), 500)?.ms).toBe(2500)
  })

  test("falls back to creation time for untimed parts", () => {
    expect(sample({ ...msg("a", 1000, 3000, 100), content: [{ type: "text" }] } as any)?.ms).toBe(
      2500,
    )
  })

  test("skips unfinished, short, empty, and non-assistant messages", () => {
    expect(sample({ ...msg("a", 0, 1000, 10), time: { created: 0 } } as any)).toBeUndefined()
    expect(sample(msg("a", 0, 100, 10))).toBeUndefined()
    expect(sample(msg("a", 0, 1000, 0))).toBeUndefined()
    expect(sample({ ...msg("a", 0, 1000, 10), type: "user" } as any)).toBeUndefined()
  })
})

describe("samples", () => {
  test("sorts oldest first", () => {
    const a = msg("a", 5000, 6000, 10)
    const b = msg("b", 1000, 2000, 10)
    expect(samples([a, b]).map((s) => s.id)).toEqual(["b", "a"])
  })

  test("unique keeps the last copy of each message", () => {
    const old = msg("a", 0, 1000, 10)
    const fresh = msg("a", 0, 1000, 20)
    expect(unique([old, msg("b", 0, 1000, 5), fresh])).toEqual([fresh, msg("b", 0, 1000, 5)])
  })
})

describe("rate", () => {
  const list = samples([msg("a", 0, 1000, 10), msg("b", 9000, 10_000, 30)])

  test("weights by tokens and time", () => expect(rate(list)).toBe(20))
  test("filters by end time", () => expect(rate(list, 5000)).toBe(30))
  test("is undefined when empty", () => expect(rate(list, 20_000)).toBeUndefined())
})

describe("speeds", () => {
  test("reports last, windows, and session", () => {
    const list = samples([msg("a", 0, 1000, 10), msg("b", 590_000, 600_000, 300)])
    expect(speeds(list, [5, 60], 600_000)).toEqual([
      { label: "last", tps: 30 },
      { label: "5m", tps: 30 },
      { label: "1h", tps: 310 / 11 },
      { label: "session", tps: 310 / 11 },
    ])
  })
})

describe("pricing", () => {
  test("finds a model by id or raw model id", () => {
    const models = [model([])]
    expect(findModel(models, { providerID: "p", id: "m" })).toBe(models[0])
    expect(findModel(models, { providerID: "p", id: "m-raw" })).toBe(models[0])
    expect(findModel(models, { providerID: "q", id: "m" })).toBeUndefined()
  })

  test("uses the untiered price", () => {
    const m = model([tier(6, 30, 0.6, 7.5, 200_000), tier(3, 15, 0.3, 3.75)])
    expect(price(m)).toEqual({ input: 3, cached: 0.3, write: 3.75, output: 15 })
    expect(price(model([]))).toBeUndefined()
  })
})

describe("spend", () => {
  const priced = (id: string, tokens: object, cost: number, ref = { id: "m", providerID: "p" }) =>
    ({ id, type: "assistant", model: ref, tokens, cost }) as unknown as SessionMessageInfo
  const models = [model([tier(2, 10, 0.5, 4)])]
  const tokens = { input: 1e6, output: 1e5, reasoning: 1e5, cache: { read: 2e6, write: 5e5 } }

  test("prices each category, billing reasoning as output", () => {
    const s = spend([priced("a", tokens, 7)], models)
    expect(s).toEqual({ input: 2, cached: 1, write: 2, output: 2, billed: 7 })
    expect(total(s)).toBe(7)
    expect(matches(s)).toBe(true)
  })

  test("flags messages whose model is missing from the catalog", () => {
    const ref = { id: "gone", providerID: "p" }
    const s = spend([priced("a", tokens, 7), priced("b", tokens, 3, ref)], models)
    expect(s.billed).toBe(10)
    expect(matches(s)).toBe(false)
  })

  test("ignores non-assistant messages", () => {
    const user = { id: "u", type: "user" } as unknown as SessionMessageInfo
    expect(spend([user], models).billed).toBe(0)
  })
})

describe("format", () => {
  test("rates", () => {
    expect(fmtRate(undefined)).toBe("—")
    expect(fmtRate(4.26)).toBe("4.3 tok/s")
    expect(fmtRate(42.6)).toBe("43 tok/s")
  })

  test("prices", () => {
    expect(fmtPrice(3)).toBe("$3.00/M")
    expect(fmtPrice(0.075)).toBe("$0.075/M")
  })

  test("dollars", () => {
    expect(fmtUSD(0)).toBe("$0.00")
    expect(fmtUSD(0.004)).toBe("<$0.01")
    expect(fmtUSD(1.239)).toBe("$1.24")
  })
})
