import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts", "src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  jsx: true, // Needed for TSX components (ConfigTUI, chat TUI)
  external: [
    "@modelcontextprotocol/sdk",
    "ink",
    "react",
    "react-reconciler",
    "ink-text-input",
    "ink-spinner",
    "scheduler",
    "zod",
    "memeloop",
    "@memeloop/protocol",
  ],
});
