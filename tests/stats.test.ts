import type { ModelInfo, SessionMessageInfo } from "@opencode/client"
import { describe, expect, test } from "bun:test"
import { findModel, fmtPrice, fmtRate, price, rate, sample, samples, speeds } from "../src/stats"

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
  test("dedupes by id and sorts oldest first", () => {
    const a = msg("a", 5000, 6000, 10)
    const b = msg("b", 1000, 2000, 10)
    expect(samples([a, b, a]).map((s) => s.id)).toEqual(["b", "a"])
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
})
