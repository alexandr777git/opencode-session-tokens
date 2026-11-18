import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "session-tokens",
  setup(ctx) {
    // счётчик целиком живёт в GUI-части; серверная часть нужна только
    // чтобы плагин зарегистрировался и получил явный id
  },
})