import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { zodLocaleStubPlugin } from "../../../packages/plugin-build/src/zod-locale-stub.mjs";

const result = await build({
  entryPoints: [
    fileURLToPath(
      new URL("../src/services/threads/thread-read-worker.ts", import.meta.url),
    ),
  ],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  define: { "import.meta.url": "__threadReadModuleUrl" },
  external: ["better-sqlite3"],
  banner: {
    js: 'const __threadReadModuleUrl = require("node:worker_threads").workerData.moduleUrl; require = require("node:module").createRequire(__threadReadModuleUrl);',
  },
  plugins: [zodLocaleStubPlugin()],
  write: false,
});
await mkdir(new URL("../src/generated/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../src/generated/thread-read-worker.ts", import.meta.url),
  `export const threadReadWorkerSource = ${JSON.stringify(result.outputFiles[0].text)};\n`,
);
