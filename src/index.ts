import type { Plugin } from "@opencode/plugin"
import { ID } from "./id"

/** No-op server part; OpenCode loads a package's TUI part only when its server part loads. */
export default { id: ID, setup() {} } satisfies Plugin.Plugin
