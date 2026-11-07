import type { SessionMessageInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { ID } from "./id"
import type { RGBA } from "@opentui/core"
import {
  findModel,
  fmtPrice,
  fmtRate,
  fmtUSD,
  matches,
  price,
  samples,
  speeds,
  spend,
  total,
  unique,
  type Price,
} from "./stats"

const DEFAULT_WINDOWS = [5, 60]
// enough history for a long session without paging forever
const HISTORY_LIMIT = 1000
const PAGE_LIMIT = 200
const TICK_MS = 5000
const MAX_FIRSTS = 500

export default {
  id: ID,
  setup(ctx) {
    const minutes: number[] = ctx.options.windows ?? DEFAULT_WINDOWS
    const firsts = new Map<string, number>()
    const seen = (e: { created: number; data: { assistantMessageID: string } }) => {
      if (firsts.has(e.data.assistantMessageID)) return
      firsts.set(e.data.assistantMessageID, e.created)
      if (firsts.size > MAX_FIRSTS) firsts.delete(firsts.keys().next().value!)
    }

    // text parts are untimed in stored messages, so record first-token times as they stream
    const stops = [
      ctx.data.on("session.text.started", seen),
      ctx.data.on("session.reasoning.started", seen),
      ctx.data.on("session.tool.input.started", seen),
      ctx.ui.slot({
        append: "sidebar.content",
        render: (props) => (
          <Sidebar ctx={ctx} sessionID={props.sessionID} minutes={minutes} firsts={firsts} />
        ),
      }),
    ]
    return () => stops.forEach((stop) => stop())
  },
} satisfies Plugin.Definition

function Sidebar(props: {
  ctx: Plugin.Context
  sessionID: string
  minutes: number[]
  firsts: ReadonlyMap<string, number>
}) {
  const { ctx } = props
  const theme = ctx.theme
  const now = clock(TICK_MS)

  // the store only holds the latest page of messages, so backfill from the API
  const [history, setHistory] = createSignal<SessionMessageInfo[]>([])
  createEffect(
    on(
      () => props.sessionID,
      (id) => {
        setHistory([])
        void loadHistory(ctx, id).then((rows) => id === props.sessionID && setHistory(rows))
      },
    ),
  )

  const msgs = createMemo(() =>
    unique([...history(), ...ctx.data.session.message.list(props.sessionID)]),
  )
  const list = createMemo(() => samples(msgs(), props.firsts))
  const rows = createMemo(() => speeds(list(), props.minutes, now()))

  const session = () => ctx.data.session.get(props.sessionID)
  const models = () => ctx.data.location.model.list(session()?.location)
  const model = createMemo(() => {
    const sel = ctx.ui.model.current()
    const ref = sel ? { providerID: sel.providerID, id: sel.modelID } : session()?.model
    return ref && findModel(models(), ref)
  })
  const cost = createMemo(() => {
    const m = model()
    return (m && price(m)) ?? { input: 0, cached: 0, write: 0, output: 0 }
  })
  const spent = createMemo(() => spend(msgs(), models()))
  const priced = () => total(cost()) > 0 || total(spent()) > 0

  const Row = (p: { label: string; value: string; fg?: RGBA }) => (
    <box flexDirection="row" justifyContent="space-between">
      <text fg={theme.text.muted}>{p.label}</text>
      <text fg={p.fg ?? theme.text.base}>{p.value}</text>
    </box>
  )
  // monospace columns: rate, then spend
  const cols = (rate: string, usd: string) => `${rate.padStart(9)}  ${usd.padStart(7)}`
  const Cost = (p: { label: string; key: keyof Price }) => (
    <Row label={p.label} value={cols(fmtPrice(cost()[p.key]), fmtUSD(spent()[p.key]))} />
  )

  return (
    <box gap={1}>
      <Show when={list().length > 0}>
        <box>
          <text fg={theme.text.base}>
            <b>Speed</b>
          </text>
          <For each={rows()}>{(r) => <Row label={r.label} value={fmtRate(r.tps)} />}</For>
        </box>
      </Show>
      <Show when={model()}>
        {(m) => (
          <box>
            <text fg={theme.text.base}>
              <b>Price</b>
            </text>
            <Show when={priced()} fallback={<text fg={theme.text.faint}>{m().name}</text>}>
              <Row label={m().name} value={cols("rate", "spent")} fg={theme.text.faint} />
            </Show>
            <Show when={priced()} fallback={<text fg={theme.text.muted}>no pricing</text>}>
              <Cost label="input" key="input" />
              <Cost label="cached" key="cached" />
              <Show when={cost().write > 0 || spent().write > 0}>
                <Cost label="write" key="write" />
              </Show>
              <Cost label="output" key="output" />
              <Row label="total" value={cols("", fmtUSD(total(spent())))} />
              <Show when={!matches(spent())}>
                <text fg={theme.text.feedback.warning.base}>
                  {`billed ${fmtUSD(spent().billed)}; breakdown is approximate`}
                </text>
              </Show>
            </Show>
          </box>
        )}
      </Show>
    </box>
  )
}

/** Newest assistant messages from the API, walking cursors up to the history limit. */
async function loadHistory(ctx: Plugin.Context, sessionID: string) {
  const rows: SessionMessageInfo[] = []
  let cursor: string | undefined
  try {
    while (rows.length < HISTORY_LIMIT) {
      const page = await ctx.client.message.list({
        sessionID,
        type: "assistant",
        limit: PAGE_LIMIT,
        ...(cursor ? { cursor } : { order: "desc" }),
      })
      rows.push(...page.data)
      cursor = page.cursor.next ?? undefined
      if (!cursor || page.data.length === 0) break
    }
  } catch {
    // the live store still covers recent messages, so a failed backfill only narrows the session average
  }
  return rows
}

function clock(ms: number) {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), ms)
  onCleanup(() => clearInterval(timer))
  return now
}
