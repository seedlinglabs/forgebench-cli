// OpenCode 2.x loads `server.js` from a plugin directory (never package.json `main`).
// The host injects `@opencode/plugin`, so nothing is installed at runtime.
import { Plugin } from "@opencode/plugin"
import { PLUGIN_ID, setup } from "./src/plugin.js"

export default Plugin.define({ id: PLUGIN_ID, setup })
