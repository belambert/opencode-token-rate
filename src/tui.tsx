import type { SessionMessageInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { ID } from "./id"
import { findModel, fmtPrice, fmtRate, price, samples, speeds } from "./stats"

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

  const list = createMemo(() =>
    samples([...history(), ...ctx.data.session.message.list(props.sessionID)], props.firsts),
  )
  const rows = createMemo(() => speeds(list(), props.minutes, now()))

  const model = createMemo(() => {
    const session = ctx.data.session.get(props.sessionID)
    const sel = ctx.ui.model.current()
    const ref = sel ? { providerID: sel.providerID, id: sel.modelID } : session?.model
    return ref && findModel(ctx.data.location.model.list(session?.location), ref)
  })
  const cost = createMemo(() => {
    const m = model()
    return m && price(m)
  })
  const free = () => {
    const c = cost()
    return !c || c.input + c.cached + c.write + c.output === 0
  }

  const Row = (p: { label: string; value: string }) => (
    <box flexDirection="row" justifyContent="space-between">
      <text fg={theme.text.muted}>{p.label}</text>
      <text fg={theme.text.base}>{p.value}</text>
    </box>
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
            <text fg={theme.text.faint}>{m().name}</text>
            <Show when={!free()} fallback={<text fg={theme.text.muted}>no pricing</text>}>
              <Row label="input" value={fmtPrice(cost()!.input)} />
              <Row label="cached" value={fmtPrice(cost()!.cached)} />
              <Show when={cost()!.write > 0}>
                <Row label="cache write" value={fmtPrice(cost()!.write)} />
              </Show>
              <Row label="output" value={fmtPrice(cost()!.output)} />
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
