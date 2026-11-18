import { createSignal, onCleanup, Show } from "solid-js"
import {
  Command, Panel, Slot, createLatest, usePlugin, Plugin,
  type MountedSession, type PanelTab,
} from "@opencode/plugin/gui"

type Totals = {
  input: number; output: number; reasoning: number
  cacheRead: number; cacheWrite: number; cost: number; turns: number
}
const zero = (): Totals => ({
  input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0,
})

// Пробуем несколько имён SDK-метода (v2 экспериментальный) — какое-то да сработает.
async function fetchMessages(client: any, sessionID: string, signal: AbortSignal): Promise<any[]> {
  const attempts = [
    () => client.session.messages({ sessionID }, { signal }),
    () => client.session.message?.list({ sessionID }, { signal }),
    () => client.session.context({ sessionID }, { signal }),
  ]
  let lastError: unknown
  for (const attempt of attempts) {
    try {
      const res = await attempt()
      const list = Array.isArray(res) ? res : (res?.data ?? res?.messages ?? [])
      if (Array.isArray(list)) return list
    } catch (e) {
      lastError = e
    }
  }
  throw lastError ?? new Error("Не нашёл API списка сообщений в SDK")
}

async function readTotals(session: MountedSession, signal: AbortSignal): Promise<Totals> {
  const messages = await fetchMessages(session.server.client, session.id, signal)
  const t = zero()
  for (const m of messages) {
    const info = m.info ?? m
    if (info.role !== "assistant" || !info.tokens) continue
    const tok = info.tokens
    t.input      += tok.input ?? 0
    t.output     += tok.output ?? 0
    t.reasoning  += tok.reasoning ?? 0
    t.cacheRead  += tok.cache?.read ?? 0
    t.cacheWrite += tok.cache?.write ?? 0
    t.cost       += info.cost ?? 0
    t.turns      += 1
  }
  return t
}

// Live-обновление: тик раз в 1.5 с + перезапрос при смене сессии.
function useTotals(session: () => MountedSession | undefined) {
  const [tick, setTick] = createSignal(0)
  const timer = setInterval(() => setTick((n) => n + 1), 1500)
  onCleanup(() => clearInterval(timer))
  return createLatest(
    () => ({ id: session()?.id, tick: tick() }),
    (_key, signal) => {
      const s = session()
      return s ? readTotals(s, signal) : Promise.resolve(zero())
    },
  )
}

function Row(props: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", "justify-content": "space-between", gap: "16px" }}>
      <span style={{ opacity: 0.7 }}>{props.label}</span>
      <span>{props.value}</span>
    </div>
  )
}

function ErrorNote(props: { error: unknown }) {
  return (
    <Show when={props.error}>
      <div style={{ color: "#e5534b", "white-space": "pre-wrap", "margin-top": "8px" }}>
        {String((props.error as any)?.message ?? props.error)}
      </div>
    </Show>
  )
}

function TotalsView(props: { session: MountedSession }) {
  const ctx = usePlugin()
  const data = useTotals(() => props.session)
  const t = () => data.latest ?? zero()
  const n = (x: number) => x.toLocaleString()
  return (
    <div style={{ padding: "12px", "font-family": ctx.appearance.font("mono"), "font-size": "12px", "line-height": 1.8 }}>
      <div style={{ "font-weight": 600, "margin-bottom": "8px" }}>{ctx.t("title")}</div>
      <Row label={ctx.t("input")}     value={n(t().input)} />
      <Row label={ctx.t("output")}    value={n(t().output)} />
      <Row label={ctx.t("reasoning")} value={n(t().reasoning)} />
      <Row label={ctx.t("cache")}     value={`${n(t().cacheRead)} / ${n(t().cacheWrite)}`} />
      <Row label={ctx.t("turns")}     value={n(t().turns)} />
      <Row label={ctx.t("cost")}      value={`$${t().cost.toFixed(4)}`} />
      <ErrorNote error={data.error} />
    </div>
  )
}

function BottomStatus() {
  const ctx = usePlugin()
  const data = useTotals(() => ctx.sessions.current())
  const t = () => data.latest ?? zero()
  return (
    <Show when={ctx.sessions.current()}>
      <span style={{ "font-family": ctx.appearance.font("mono"), "font-size": "11px", opacity: 0.85 }}>
        Σ in {t().input.toLocaleString()} · out {t().output.toLocaleString()} · ${t().cost.toFixed(4)}
      </span>
    </Show>
  )
}

export default Plugin.define({
  i18n: {
    en: { title: "Session tokens", input: "Input", output: "Output", reasoning: "Reasoning", cache: "Cache r/w", turns: "Turns", cost: "Cost", open: "Show session tokens" },
    ru: { title: "Токены сессии", input: "Входящие", output: "Исходящие", reasoning: "Рассуждения", cache: "Кэш ч/з", turns: "Ходов", cost: "Стоимость", open: "Показать токены сессии" },
  },
  setup(ctx) {
    const tab: PanelTab = {
      id: "totals",
      get title() { return ctx.t("title") },
      closable: "compact",
      fallback: true,
    }
    ctx.add(Panel, {
      id: "totals",
      region: "side",
      width: "narrow",
      list: (input) => (input.open.includes("totals") ? [tab] : []),
      render: (props) => <TotalsView session={props.session} />,
    })
    ctx.add(Slot, { at: "window.bottom", render: () => <BottomStatus /> })
    ctx.add(Command, (): Command => ({
      id: "open",
      title: ctx.t("open"),
      section: "session",
      bind: "mod+alt+t",
      slash: { name: "tokens" },
      enabled: !!ctx.sessions.current(),
      run: () => {
        const s = ctx.sessions.current()
        if (s) ctx.layout.toggle(`${ctx.id}:totals`, s)
      },
    }))
  },
})