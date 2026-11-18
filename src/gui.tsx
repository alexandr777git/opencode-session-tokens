import { Command, Plugin } from "@opencode/plugin/gui"

export default Plugin.define({
  i18n: {
    en: { ping: "Session tokens: ping" },
    ru: { ping: "Токены сессии: проверка" },
  },
  setup(ctx) {
    ctx.add(Command, (): Command => ({
      id: "ping",
      title: ctx.t("ping"),
      run: () => {
        console.log("[session-tokens] ping")
        try { ctx.toast.show({ title: ctx.t("ping") }) } catch {}
      },
    }))
  },
})