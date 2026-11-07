import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

// OpenCode skips the Solid transform for code under node_modules, so ship pre-transformed JS;
// keep packages external so the plugin shares the host's Solid runtime
const result = await Bun.build({
  entrypoints: ["src/index.ts", "src/tui.tsx"],
  outdir: "dist",
  target: "bun",
  format: "esm",
  packages: "external",
  plugins: [createSolidTransformPlugin()],
})
if (!result.success) throw new AggregateError(result.logs, "build failed")
for (const out of result.outputs) console.log(out.path)
