import { createSignal, onCleanup, Show } from "solid-js"
import {
  Command, ComposerPill, MenuItem, Panel, Slot, createLatest, usePlugin, Plugin,
  type MountedSession, type PanelTab,
} from "@opencode/plugin/gui"

type Totals = {
  input: number; output: number; reasoning: number
  cacheRead: number; cacheWrite: number; cost: number; turns: number
}
type Read = { totals: Totals; count: number; sampleKeys: string | null; lastPrompt?: { input: number; cacheRead: number; cacheWrite: number } }
type SubTotals = {
  input: number; output: number; reasoning: number
  cacheRead: number; cacheWrite: number; cost: number; children: number
}
type SubRead = { sub: SubTotals }

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)
const zero = (): Totals =>
  ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 })
const zeroSub = (): SubTotals =>
  ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, children: 0 })

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "0"
  const abs = Math.abs(n)
  if (abs >= 999_950) return `${(n / 1e6).toFixed(1)}M`
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

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
  throw lastError ?? new Error("SDK: не нашёл метод списка сообщений")
}

async function readSession(client: any, sessionID: string, signal: AbortSignal): Promise<Read> {
  const messages = await fetchMessages(client, sessionID, signal)
  const t = zero()
  let sample: string | null = null
  let lastPrompt: Read["lastPrompt"] = undefined
  for (const m of messages) {
    if (!m || typeof m !== "object") continue
    const info = m.info && typeof m.info === "object" ? m.info : m
    const role = info.role ?? info.type ?? m.role ?? m.type
    if (role !== "assistant") continue
    const tok = info.tokens ?? m.tokens ?? info.usage ?? m.usage
    if (!tok || typeof tok !== "object") {
      if (!sample) {
        const keys = new Set<string>([...Object.keys(m), ...Object.keys(info).map((k) => `info.${k}`)])
        sample = [...keys].join(", ")
      }
      continue
    }
    const input = num(tok.input)
    const cacheRead = num(tok.cache?.read ?? tok.cacheRead)
    const cacheWrite = num(tok.cache?.write ?? tok.cacheWrite)
    t.input += input
    t.output += num(tok.output)
    t.reasoning += num(tok.reasoning)
    t.cacheRead += cacheRead
    t.cacheWrite += cacheWrite
    t.cost += num(info.cost ?? m.cost)
    t.turns += 1
    lastPrompt = { input, cacheRead, cacheWrite }
  }
  return { totals: t, count: messages.length, sampleKeys: sample, lastPrompt }
}

// ---- Субагенты: дети + внуки по parentID, готовые агрегаты хоста (ADR-012) ----

const MAX_PAGES = 10 // страниц по курсору на одного родителя
const MAX_QUERIES = 16 // бюджет запросов list на одно чтение
const MAX_KIDS = 64 // максимум учитываемых субагентов

async function listSessions(
  client: any, input: unknown, signal: AbortSignal,
): Promise<{ list: any[]; next?: string } | null> {
  try {
    const res = await client.session.list(input, { signal })
    const list = Array.isArray(res) ? res : (res?.data ?? res?.sessions ?? null)
    if (!Array.isArray(list)) return null
    const next = res?.cursor?.next
    return { list, next: typeof next === "string" && next ? next : undefined }
  } catch {
    return null
  }
}

async function listChildren(client: any, parentID: string, signal: AbortSignal): Promise<any[] | null> {
  const out: any[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const input: Record<string, unknown> = { parentID, limit: 100, order: "asc" }
    if (cursor) input.cursor = cursor
    const res = await listSessions(client, input, signal)
    if (!res) return out.length > 0 ? out : null
    out.push(...res.list)
    if (!res.next) break
    cursor = res.next
  }
  return out
}

async function fetchChildren(client: any, sessionID: string, signal: AbortSignal): Promise<any[]> {
  const seen = new Set<string>([sessionID])
  const queue = [sessionID]
  const kids: any[] = []
  let queries = 0
  while (queue.length > 0 && kids.length < MAX_KIDS) {
    const parent = queue.shift()!
    if (queries >= MAX_QUERIES) break
    queries += 1
    const found = await listChildren(client, parent, signal)
    if (found === null) throw new Error("SDK: не нашёл метод session.list (фильтр parentID)")
    for (const s of found) {
      if (!s || typeof s !== "object") continue
      const id = typeof s.id === "string" ? s.id : null
      if (!id || seen.has(id)) continue
      seen.add(id)
      kids.push(s)
      queue.push(id)
    }
  }
  return kids
}

async function readChildren(client: any, sessionID: string, signal: AbortSignal): Promise<SubRead> {
  const kids = await fetchChildren(client, sessionID, signal)
  const t = zeroSub()
  for (const s of kids) {
    if (!s || typeof s !== "object") continue
    const tok = s.tokens ?? s.usage // один ??-каскад на поле (И-7)
    if (!tok || typeof tok !== "object") continue
    t.input += num(tok.input)
    t.output += num(tok.output)
    t.reasoning += num(tok.reasoning)
    t.cacheRead += num(tok.cache?.read ?? tok.cacheRead)
    t.cacheWrite += num(tok.cache?.write ?? tok.cacheWrite)
    t.cost += num(s.cost)
    t.children += 1
  }
  return { sub: t }
}

function useRead(session: () => MountedSession | undefined) {
  const [tick, setTick] = createSignal(0)
  const timer = setInterval(() => setTick((n) => n + 1), 5000)
  onCleanup(() => clearInterval(timer))
  return createLatest(
    () => ({ id: session()?.id, tick: tick() }),
    (_k, signal) => {
      const s = session()
      return s
        ? readSession(s.server.client, s.id, signal)
        : Promise.resolve({ totals: zero(), count: 0, sampleKeys: null } as Read)
    },
  )
}

function useSubRead(session: () => MountedSession | undefined) {
  const [tick, setTick] = createSignal(0)
  const timer = setInterval(() => setTick((n) => n + 1), 5000)
  onCleanup(() => clearInterval(timer))
  return createLatest(
    () => ({ id: session()?.id, tick: tick() }),
    (_k, signal) => {
      const s = session()
      return s
        ? readChildren(s.server.client, s.id, signal)
        : Promise.resolve({ sub: zeroSub() } as SubRead)
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

function TotalsView(props: { session: MountedSession }) {
  const ctx = usePlugin()
  const data = useRead(() => props.session)
  const subs = useSubRead(() => props.session)
  const rec = () => data.latest ?? ({ totals: zero(), count: 0, sampleKeys: null } as Read)
  const subRec = () => subs.latest ?? ({ sub: zeroSub() } as SubRead)
  const t = () => rec().totals
  const sub = () => subRec().sub
  const totalCost = () => t().cost + sub().cost
  const n = (x: number) => x.toLocaleString("ru")
  return (
    <div style={{ padding: "12px", "font-family": ctx.appearance.font("mono"), "font-size": "12px", "line-height": 1.8 }}>
      <div style={{ "font-weight": 600, "margin-bottom": "8px" }}>{ctx.t("title")}</div>
      <Row label={ctx.t("input")} value={n(t().input)} />
      <Row label={ctx.t("output")} value={n(t().output)} />
      <Row label={ctx.t("reasoning")} value={n(t().reasoning)} />
      <Row label={ctx.t("cache")} value={`${n(t().cacheRead)} / ${n(t().cacheWrite)}`} />
      <Show when={rec().lastPrompt}>
        <Row label={ctx.t("contextSize")} value={n(rec().lastPrompt.input + rec().lastPrompt.cacheRead + rec().lastPrompt.cacheWrite)} />
      </Show>
      <Row label={ctx.t("turns")} value={n(t().turns)} />
      <Show when={sub().children > 0}>
        <Row label={ctx.t("subagents")} value={n(sub().input + sub().output + sub().reasoning)} />
        <Row label={ctx.t("subagentsCache")} value={`${n(sub().cacheRead)} / ${n(sub().cacheWrite)}`} />
      </Show>
      <Row label={ctx.t("totalCost")} value={`$${totalCost().toFixed(4)}`} />
      <Show when={data.error}>
        <div style={{ color: "#e5534b", "white-space": "pre-wrap", "margin-top": "8px" }}>
          {String((data.error as any)?.message ?? data.error)}
        </div>
      </Show>
      <Show when={!data.error && rec().count > 0 && t().turns === 0}>
        <div style={{ opacity: 0.7, "margin-top": "8px", "white-space": "pre-wrap" }}>
          сообщений: {rec().count}, токены не найдены.
          <Show when={rec().sampleKeys}>
            <div>ключи assistant: {rec().sampleKeys}</div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

function BottomStatus() {
  const ctx = usePlugin()
  const data = useRead(() => ctx.sessions.current())
  const subs = useSubRead(() => ctx.sessions.current())
  const t = () => (data.latest ?? ({ totals: zero(), count: 0, sampleKeys: null } as Read)).totals
  const sub = () => (subs.latest ?? ({ sub: zeroSub() } as SubRead)).sub
  const parentCost = () => t().cost
  const totalCost = () => t().cost + sub().cost
  return (
    <Show when={ctx.sessions.current()}>
      <span style={{ "font-family": ctx.appearance.font("mono"), "font-size": "11px", opacity: 0.85 }}>
        Σ in {t().input.toLocaleString("ru")} · out {t().output.toLocaleString("ru")} · ${parentCost().toFixed(4)} (${totalCost().toFixed(4)})
      </span>
    </Show>
  )
}

export default Plugin.define({
  i18n: {
    en: { title: "Session tokens", input: "Input (excl. cache)", output: "Output", reasoning: "Reasoning", cache: "Cache r/w", contextSize: "Context size", turns: "Turns", subagents: "Subagents", subagentsCache: "Subagents cache", totalCost: "Total cost", cost: "Cost", open: "Show session tokens", menuTitle: "Session tokens" },
    ru: { title: "Токены сессии", input: "Входящие (без кэша)", output: "Исходящие", reasoning: "Рассуждения", cache: "Кэш ч/з", contextSize: "Размер контекста", turns: "Ходов", subagents: "Субагенты", subagentsCache: "Кэш субагентов", totalCost: "Итого стоимость", cost: "Стоимость", open: "Показать токены сессии", menuTitle: "Токены сессии" },
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
      list: (input) => (input.open.includes("totals") ? [tab] : []),
      render: (props) => <TotalsView session={props.session} />,
    })
    ctx.add(Slot, { at: "window.bottom", render: () => <BottomStatus /> })
    ctx.add(Command, (): Command => ({
      id: "open",
      title: ctx.t("open"),
      section: "session",
      slash: { name: "tokens" },
      enabled: !!ctx.sessions.current(),
      run: () => {
        const s = ctx.sessions.current()
        if (s) ctx.layout.toggle(`${ctx.id}:totals`, s)
      },
    }))

    ctx.add(MenuItem, (): MenuItem => ({
      id: "open-totals",
      menu: "session.panel",
      get title() { return ctx.t("menuTitle") },
      icon: "outline-list-changelog",
      get opened() {
        const s = ctx.sessions.current()
        return !!s && ctx.layout.state(`${ctx.id}:totals`, s) !== "closed"
      },
      run: () => {
        const s = ctx.sessions.current()
        if (s) ctx.layout.toggle(`${ctx.id}:totals`, s)
      },
    }))

    // ---- Пилюля в композере рядом с "NN% ctx" ----
    const cache = new Map<string, { at: number; totals: Totals }>()
    const inflight = new Set<string>()
    const [version, setVersion] = createSignal(0)
    const ticker = setInterval(() => setVersion((v) => v + 1), 5000)

    let pendingController: AbortController | null = null
    onCleanup(() => {
      clearInterval(ticker)
      pendingController?.abort()
    })

    const refresh = (session: MountedSession) => {
      if (inflight.has(session.id)) return
      inflight.add(session.id)
      const controller = new AbortController()
      pendingController = controller
      readSession(session.server.client, session.id, controller.signal)
        .then((read) => {
          cache.set(session.id, { at: Date.now(), totals: read.totals })
          if (cache.size > 64) {
            const oldest = cache.keys().next().value
            if (oldest !== undefined) cache.delete(oldest)
          }
          setVersion((v) => v + 1)
        })
        .catch(() => {})
        .finally(() => inflight.delete(session.id))
    }

    ctx.add(ComposerPill, () => ({
      id: "totals",
      show: (input: any) => {
        version() // реактивная зависимость: перерисовка при обновлении кэша
        const session = input?.session as MountedSession | undefined
        if (!session) return undefined
        const entry = cache.get(session.id)
        if (!entry) { refresh(session); return undefined }
        if (Date.now() - entry.at > 5000) refresh(session)
        const t = entry.totals
        const total = t.input + t.output + t.reasoning
        return {
          label: `Σ ${fmt(total)} ⟳ ${fmt(t.cacheRead)}/${fmt(t.cacheWrite)}`,
          run: () => ctx.layout.toggle(`${ctx.id}:totals`, session),
        }
      },
    }))
  },
})