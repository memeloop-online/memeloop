import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import ts from "typescript";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageDirectory, "../..");
const cliPackageDirectory = path.join(repositoryRoot, "packages", "memeloop-cli");

/**
 * Resolve the package's published node entry points instead of assuming that
 * declaration/runtime files will always live under `dist/index.*`.
 */
export function resolvePackageEntryTargets(manifest) {
  const rootExport = manifest?.exports?.["."];
  const nodeExport = rootExport?.node ?? rootExport?.default ?? rootExport;
  const nodeTargets = typeof nodeExport === "string" ? { import: nodeExport } : nodeExport;
  if (!nodeTargets || typeof nodeTargets !== "object") {
    throw new Error(`${manifest?.name ?? "package"}: root node export map is missing`);
  }
  if (typeof manifest.types !== "string" || typeof nodeTargets.types !== "string") {
    throw new Error(`${manifest?.name ?? "package"}: root node types export is missing`);
  }
  const manifestTypesTarget = manifest.types.startsWith("./")
    ? manifest.types
    : `./${manifest.types}`;
  if (manifestTypesTarget !== nodeTargets.types) {
    throw new Error(
      `${manifest?.name ?? "package"}: manifest.types (${manifest.types}) must match ` +
        `exports["."].node.types (${nodeTargets.types})`,
    );
  }
  for (const field of ["import", "require"]) {
    if (typeof nodeTargets[field] !== "string") {
      throw new Error(`${manifest?.name ?? "package"}: root node ${field} export is missing`);
    }
  }
  return {
    types: manifestTypesTarget,
    import: nodeTargets.import,
    require: nodeTargets.require,
  };
}

export function assertPackageEntryContract(
  manifest = JSON.parse(fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8")),
  packageRoot = packageDirectory,
) {
  const targets = resolvePackageEntryTargets(manifest);
  const resolvedRoot = path.resolve(packageRoot);
  return Object.fromEntries(
    Object.entries(targets).map(([field, target]) => {
      if (!target.startsWith("./")) {
        throw new Error(`${manifest.name}: ${field} export must be a local './' target`);
      }
      const absolute = path.resolve(resolvedRoot, target);
      if (!absolute.startsWith(`${resolvedRoot}${path.sep}`)) {
        throw new Error(`${manifest.name}: ${field} export escapes the package directory`);
      }
      if (!fs.existsSync(absolute)) {
        throw new Error(`${manifest.name}: ${field} export target '${target}' is missing`);
      }
      return [field, absolute];
    }),
  );
}

async function run() {
  const packageEntries = assertPackageEntryContract();
  if (process.argv.includes("--self-check")) {
    console.log("Zod portability scanner package export/types self-check passed.");
    return;
  }

  const firstZod = findZodPackage();
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "memeloop-zod-boundary-"));
  let secondZod = findZodPackage(firstZod);
  if (!secondZod) {
    const copiedZod = path.join(temporaryDirectory, "zod-copy");
    fs.cpSync(firstZod.directory, copiedZod, { recursive: true });
    secondZod = { directory: copiedZod, version: firstZod.version };
  }

  try {
    assertConsumerTypes(
      firstZod.directory,
      secondZod.directory,
      temporaryDirectory,
      packageEntries.import,
    );
    await assertRuntimeBoundary(firstZod.directory, secondZod.directory, packageEntries.import);
    console.log(
      `Zod portability contract passed with ${firstZod.version} and ${secondZod.version} ` +
        "from independent package copies.",
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

const invokedScript = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedScript === import.meta.url) {
  await run();
}

function findZodPackage(excluded) {
  const virtualStoreRoots = [
    path.join(packageDirectory, "node_modules", ".pnpm"),
    path.join(cliPackageDirectory, "node_modules", ".pnpm"),
    path.join(repositoryRoot, "node_modules", ".pnpm"),
  ];
  const candidates = [
    path.join(packageDirectory, "node_modules", "zod"),
    path.join(cliPackageDirectory, "node_modules", "zod"),
    path.join(repositoryRoot, "node_modules", "zod"),
  ];
  for (const virtualStoreRoot of virtualStoreRoots) {
    if (!fs.existsSync(virtualStoreRoot)) continue;
    for (const entry of fs.readdirSync(virtualStoreRoot)) {
      if (entry.startsWith("zod@")) {
        candidates.push(path.join(virtualStoreRoot, entry, "node_modules", "zod"));
      }
    }
  }

  const excludedDirectory = excluded ? realpathOrNull(excluded.directory) : undefined;
  const seen = new Set();
  for (const candidate of candidates) {
    const directory = realpathOrNull(candidate);
    if (!directory || directory === excludedDirectory || seen.has(directory)) continue;
    seen.add(directory);
    const packageJson = path.join(directory, "package.json");
    if (!fs.existsSync(packageJson)) continue;
    const metadata = JSON.parse(fs.readFileSync(packageJson, "utf8"));
    if (typeof metadata.version === "string" && /^4\./u.test(metadata.version)) {
      return { directory, version: metadata.version };
    }
  }
  if (excluded) return undefined;
  throw new Error("No installed Zod 4 package was found for the portability contract check");
}

function realpathOrNull(directory) {
  try {
    return fs.realpathSync(directory);
  } catch {
    return undefined;
  }
}

function assertConsumerTypes(
  firstZodDirectory,
  secondZodDirectory,
  temporaryDirectory,
  runtimeEntry,
) {
  const sourcePath = path.join(temporaryDirectory, "consumer.mts");
  const source = `
import { defineTool, schemaToToolContent, toolSchemaToJsonSchema } from ${JSON.stringify(runtimeEntry)};
import { z as zodA } from ${JSON.stringify(path.join(firstZodDirectory, "index.js"))};
import { z as zodB } from ${JSON.stringify(path.join(secondZodDirectory, "index.js"))};

const configSchema = zodA.object({ enabled: zodA.boolean() });
const parameterSchema = zodB.object({ query: zodB.string() });

defineTool({
  toolId: 'portable-zod-consumer',
  displayName: 'Portable Zod consumer',
  description: 'Checks schemas from two independent Zod packages.',
  configSchema,
  llmToolSchemas: { search: parameterSchema },
  onProcessPrompts({ config }) {
    const enabled: boolean = config.enabled;
    void enabled;
  },
  onResponseComplete({ executeToolCall }) {
    void executeToolCall('search', async parameters => {
      const query: string = parameters.query;
      return { success: true, data: query };
    });
  },
});

const jsonSchema = toolSchemaToJsonSchema(parameterSchema);
const content = schemaToToolContent(parameterSchema);
if (jsonSchema.type !== 'object' || !content.includes('- query (string, required)')) {
  throw new Error('Portable Zod consumer runtime assertions failed');
}
`;
  fs.writeFileSync(sourcePath, source);

  const options = {
    customConditions: ["node"],
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: false,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    types: ["node"],
  };
  const program = ts.createProgram([sourcePath], options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (file) => file,
        getCurrentDirectory: () => packageDirectory,
        getNewLine: () => "\n",
      }),
    );
  }
}

async function assertRuntimeBoundary(firstZodDirectory, secondZodDirectory, runtimeEntry) {
  const core = await import(pathToFileURL(runtimeEntry).href);
  const zodA = await import(pathToFileURL(path.join(firstZodDirectory, "index.js")).href);
  const zodB = await import(pathToFileURL(path.join(secondZodDirectory, "index.js")).href);
  const configSchema = zodA.z.object({ enabled: zodA.z.boolean() });
  const parameterSchema = zodB.z.object({ query: zodB.z.string() });

  const defined = core.defineTool({
    toolId: "portable-zod-runtime",
    displayName: "Portable Zod runtime",
    description: "Checks runtime conversion across package copies.",
    configSchema,
    llmToolSchemas: { search: parameterSchema },
  });
  assert.equal(defined.configSchema, configSchema);
  const jsonSchema = core.toolSchemaToJsonSchema(parameterSchema);
  assert.equal(jsonSchema.type, "object");
  assert.deepEqual(jsonSchema.required, ["query"]);
  assert.match(core.schemaToToolContent(parameterSchema), /- query \(string, required\)/u);
}
