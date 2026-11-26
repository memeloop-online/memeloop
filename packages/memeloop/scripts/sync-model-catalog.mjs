import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://models.dev/api.json";
const validModelDate = (value) =>
  typeof value === "string" && /^\d{4}-\d{2}(?:-\d{2})?$/u.test(value) &&
  !Number.isNaN(Date.parse(`${value}${value.length === 7 ? "-01" : ""}T00:00:00.000Z`));
const OUTPUT_URL = new URL("../src/modelCatalog/embeddedCatalog.generated.ts", import.meta.url);
const MAX_BYTES = 8 * 1024 * 1024;
const compareCodeUnits = (left, right) => left < right ? -1 : left > right ? 1 : 0;

const inputIndex = process.argv.indexOf("--input");
const inputPath = inputIndex >= 0 ? process.argv[inputIndex + 1] : undefined;
if (inputIndex >= 0 && !inputPath) throw new Error("--input requires a file path");

async function readBoundedResponse(response, maxBytes) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes)
    throw new Error(`Catalog exceeds ${maxBytes} bytes`);
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel(`Catalog exceeds ${maxBytes} bytes`);
        throw new Error(`Catalog exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

let response;
let bytes;
if (inputPath) {
  bytes = new Uint8Array(await readFile(inputPath));
} else {
  response = await fetch(SOURCE_URL, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Catalog request failed with HTTP ${response.status}`);
  bytes = await readBoundedResponse(response, MAX_BYTES);
}
if (bytes.byteLength > MAX_BYTES) throw new Error(`Catalog exceeds ${MAX_BYTES} bytes`);
const upstream = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
if (typeof upstream !== "object" || upstream === null || Array.isArray(upstream))
  throw new Error("Catalog root must be an object");

const providers = Object.entries(upstream)
  .flatMap(([fallbackId, value]) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const id = typeof value.id === "string" && value.id ? value.id : fallbackId;
    if (typeof value.models !== "object" || value.models === null || Array.isArray(value.models))
      return [];
    const models = Object.entries(value.models)
      .flatMap(([fallbackModelId, model]) => {
        if (typeof model !== "object" || model === null || Array.isArray(model)) return [];
        const modelId = typeof model.id === "string" && model.id ? model.id : fallbackModelId;
        return [
          {
            id: modelId,
            name: typeof model.name === "string" && model.name.trim() ? model.name.trim() : modelId,
            attachment: model.attachment === true,
            reasoning: model.reasoning === true,
            toolCall: model.tool_call === true,
            ...(typeof model.structured_output === "boolean"
              ? { structuredOutput: model.structured_output }
              : {}),
            ...(typeof model.temperature === "boolean" ? { temperature: model.temperature } : {}),
            ...(validModelDate(model.release_date) ? { releaseDate: model.release_date } : {}),
            ...(validModelDate(model.last_updated) ? { lastUpdated: model.last_updated } : {}),
            ...(["alpha", "beta", "deprecated"].includes(model.status)
              ? { status: model.status }
              : {}),
            ...(model.modalities && typeof model.modalities === "object"
              ? {
                  modalities: {
                    input: Array.isArray(model.modalities.input)
                      ? model.modalities.input.filter((item) => typeof item === "string").sort()
                      : [],
                    output: Array.isArray(model.modalities.output)
                      ? model.modalities.output.filter((item) => typeof item === "string").sort()
                      : [],
                  },
                }
              : {}),
            ...(model.limit && typeof model.limit === "object"
              ? {
                  limit: {
                    ...(Number.isFinite(model.limit.context)
                      ? { context: model.limit.context }
                      : {}),
                    ...(Number.isFinite(model.limit.input) ? { input: model.limit.input } : {}),
                    ...(Number.isFinite(model.limit.output) ? { output: model.limit.output } : {}),
                  },
                }
              : {}),
          },
        ];
      })
      .sort((left, right) => compareCodeUnits(left.id, right.id));
    return [
      {
        id,
        name: typeof value.name === "string" && value.name.trim() ? value.name.trim() : id,
        ...(typeof value.npm === "string" ? { npm: value.npm } : {}),
        ...(typeof value.api === "string" && /^https?:\/\//u.test(value.api) ? { api: value.api } : {}),
        ...(typeof value.doc === "string" && /^https?:\/\//u.test(value.doc) ? { doc: value.doc } : {}),
        env: Array.isArray(value.env)
          ? [...new Set(value.env.filter((item) => typeof item === "string"))].sort()
          : [],
        models,
      },
    ];
  })
  .sort((left, right) => compareCodeUnits(left.id, right.id));
if (providers.length === 0) throw new Error("Catalog contains no providers");

const catalog = {
  schemaVersion: 1,
  source: SOURCE_URL,
  catalogVersion:
    response?.headers.get("etag")?.replaceAll('"', "") ||
    createHash("sha256").update(bytes).digest("hex"),
  fetchedAt: new Date().toISOString(),
  providers,
};
const serialized = JSON.stringify(catalog);
const source =
  `/* Generated by scripts/sync-model-catalog.mjs from models.dev (MIT). Do not edit. */\n` +
  `import { parseModelCatalog } from './catalog.js';\n` +
  `import type { ModelCatalog } from './types.js';\n\n` +
  `const serializedCatalog: string = ${JSON.stringify(serialized)};\n` +
  `export const EMBEDDED_MODEL_CATALOG: ModelCatalog = parseModelCatalog(JSON.parse(serializedCatalog));\n`;
await writeFile(OUTPUT_URL, source, "utf8");
console.log(
  JSON.stringify({
    output: fileURLToPath(OUTPUT_URL),
    providers: providers.length,
    models: providers.reduce((sum, provider) => sum + provider.models.length, 0),
    sourceBytes: bytes.byteLength,
    generatedBytes: Buffer.byteLength(source),
    catalogVersion: catalog.catalogVersion,
  }),
);
