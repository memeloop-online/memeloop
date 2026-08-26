import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cases = [
  { name: 'browser', conditions: ['browser'] },
  { name: 'react-native', conditions: ['react-native'] },
  { name: 'node', conditions: ['node'] },
];
const requiredRootTypes = [
  'AgentDefinition',
  'AgentFrameworkConfig',
  'AgentSessionController',
  'AgentSessionSnapshot',
  'ChatMessage',
  'ConversationMessageDisplayTruncation',
  'Device',
  'PromptPreviewAuditPage',
  'PromptPreviewPreparedExecution',
  'ScheduledTaskPage',
  'ScheduledTaskPageSource',
];

for (const entry of cases) {
  assertConsumerTypeExports('memeloop', entry.conditions, requiredRootTypes);
  const declared = declaredValueExports(entry.conditions);
  const runtime = runtimeExports(entry.conditions);
  const missingAtRuntime = declared.filter(name => !runtime.includes(name));
  const missingInTypes = runtime.filter(name => !declared.includes(name));
  if (missingAtRuntime.length > 0 || missingInTypes.length > 0) {
    throw new Error(
      `${entry.name} export mismatch\n` +
        `declared only: ${missingAtRuntime.join(', ') || '(none)'}\n` +
        `runtime only: ${missingInTypes.join(', ') || '(none)'}`,
    );
  }
}
assertConsumerTypeExports('memeloop/llm-providers', ['node'], ['LLMProviderId']);
assertConsumerTypeExports(
  'memeloop/mobile/providers',
  ['react-native'],
  ['FetchLLMChatRequest', 'FetchLLMProviderConfig'],
);
assertConsumerValueExports(
  'memeloop/device-network',
  ['node'],
  ['readConversationMessagePage'],
);
assertRuntimeValueExports(
  'memeloop/device-network',
  ['node'],
  ['readConversationMessagePage'],
);
assertConsumerValueExports(
  'memeloop/testing',
  ['node'],
  ['runStorageConformance'],
);
assertRuntimeValueExports(
  'memeloop/testing',
  ['node'],
  ['runStorageConformance'],
);

function assertConsumerTypeExports(moduleName, customConditions, names) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-type-consumer-'));
  try {
    const sourcePath = path.join(temporaryDirectory, 'consumer.mts');
    fs.writeFileSync(
      sourcePath,
      `import type { ${names.join(', ')} } from '${moduleName}';\n` +
        `type Required = ${names.join(' & ')};\n` +
        'declare const required: Required;\nvoid required;\n',
    );
    const options = {
      customConditions,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      // This smoke owns MemeLoop's conditional public surface, not optional
      // peer packages' ambient Node/json-schema declarations.
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      types: [],
    };
    const host = ts.createCompilerHost(options);
    host.resolveModuleNames = (moduleNames, containingFile, reusedNames, redirectedReference, compilerOptions) =>
      moduleNames.map(candidate => ts.resolveModuleName(
        candidate,
        candidate === moduleName
          ? path.join(packageDirectory, 'scripts', 'consumer.mts')
          : containingFile,
        compilerOptions,
        host,
      ).resolvedModule);
    const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([sourcePath], options, host));
    if (diagnostics.length > 0) {
      throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: file => file,
        getCurrentDirectory: () => packageDirectory,
        getNewLine: () => '\n',
      }));
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function assertConsumerValueExports(moduleName, customConditions, names) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-value-consumer-'));
  try {
    const sourcePath = path.join(temporaryDirectory, 'consumer.mts');
    fs.writeFileSync(
      sourcePath,
      `import { ${names.join(', ')} } from '${moduleName}';\n` +
        names.map(name => `void ${name};`).join('\n') +
        '\n',
    );
    const options = {
      customConditions,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      types: [],
    };
    const host = ts.createCompilerHost(options);
    host.resolveModuleNames = (
      moduleNames,
      containingFile,
      reusedNames,
      redirectedReference,
      compilerOptions,
    ) =>
      moduleNames.map(candidate =>
        ts.resolveModuleName(
          candidate,
          candidate === moduleName
            ? path.join(packageDirectory, 'scripts', 'consumer.mts')
            : containingFile,
          compilerOptions,
          host,
        ).resolvedModule
      );
    const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([sourcePath], options, host));
    if (diagnostics.length > 0) {
      throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: file => file,
        getCurrentDirectory: () => packageDirectory,
        getNewLine: () => '\n',
      }));
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function assertRuntimeValueExports(moduleName, conditions, names) {
  const loaders = [
    {
      name: 'ESM import',
      arguments: [
        ...conditions.map(condition => `--conditions=${condition}`),
        '--input-type=module',
        '--eval',
        `import('${moduleName}').then(module => process.stdout.write(JSON.stringify(Object.keys(module))))`,
      ],
    },
    {
      name: 'CommonJS require',
      arguments: [
        ...conditions.map(condition => `--conditions=${condition}`),
        '--input-type=commonjs',
        '--eval',
        `process.stdout.write(JSON.stringify(Object.keys(require('${moduleName}'))))`,
      ],
    },
  ];
  for (const loader of loaders) {
    const result = spawnSync(process.execPath, loader.arguments, {
      cwd: packageDirectory,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(
        `${moduleName} ${loader.name} failed: ${result.stderr || result.stdout}`,
      );
    }
    const exports = JSON.parse(result.stdout);
    const missing = names.filter(name => !exports.includes(name));
    if (missing.length > 0) {
      throw new Error(`${moduleName} ${loader.name} missing: ${missing.join(', ')}`);
    }
  }
}

function declaredValueExports(customConditions) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-export-parity-'));
  try {
    const sourcePath = path.join(temporaryDirectory, 'consumer.mts');
    fs.writeFileSync(sourcePath, "import * as MemeLoop from 'memeloop';\nvoid MemeLoop;\n");
    const options = {
      customConditions,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ES2022,
      types: [],
    };
    const createHost = () => {
      const host = ts.createCompilerHost(options);
      host.resolveModuleNames = (moduleNames, containingFile, reusedNames, redirectedReference, compilerOptions) =>
      moduleNames.map(moduleName => {
        if (moduleName !== 'memeloop') {
          return ts.resolveModuleName(
            moduleName,
            containingFile,
            compilerOptions,
            host,
          ).resolvedModule;
        }
        return ts.resolveModuleName(
          moduleName,
          path.join(packageDirectory, 'scripts', 'consumer.mts'),
          compilerOptions,
          host,
        ).resolvedModule;
      });
      return host;
    };
    const host = createHost();
    const program = ts.createProgram([sourcePath], options, host);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length > 0) {
      throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: file => file,
        getCurrentDirectory: () => packageDirectory,
        getNewLine: () => '\n',
      }));
    }
    const source = program.getSourceFile(sourcePath);
    const moduleSpecifier = source?.statements[0]?.moduleSpecifier;
    if (!moduleSpecifier) throw new Error('failed to resolve consumer import');
    const checker = program.getTypeChecker();
    const moduleSymbol = checker.getSymbolAtLocation(moduleSpecifier);
    if (!moduleSymbol) throw new Error(`failed to resolve memeloop types for ${customConditions}`);
    const candidates = checker.getExportsOfModule(moduleSymbol)
      .map(symbol => symbol.name)
      .filter(name => ts.isIdentifierText(name, ts.ScriptTarget.ES2022))
      .sort();

    // Symbol flags alone cannot distinguish a value reached through
    // `export type *` from an actual namespace value. Ask the checker whether
    // each candidate is legal in a value-position property access instead.
    fs.writeFileSync(
      sourcePath,
      "import * as MemeLoop from 'memeloop';\n" +
        candidates.map(name => `void MemeLoop.${name};`).join('\n') +
        '\n',
    );
    const valueProgram = ts.createProgram([sourcePath], options, createHost());
    const valueSource = valueProgram.getSourceFile(sourcePath);
    if (!valueSource) throw new Error('failed to load value-position export checks');
    const valueChecker = valueProgram.getTypeChecker();
    return valueSource.statements.slice(1).flatMap((statement, index) => {
      if (
        !ts.isExpressionStatement(statement) ||
        !ts.isVoidExpression(statement.expression) ||
        !ts.isPropertyAccessExpression(statement.expression.expression)
      ) return [];
      return valueChecker.getSymbolAtLocation(statement.expression.expression.name)
        ? [candidates[index]]
        : [];
    });
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function runtimeExports(conditions) {
  const result = spawnSync(
    process.execPath,
    [
      ...conditions.map(condition => `--conditions=${condition}`),
      '--input-type=module',
      '--eval',
      "import('memeloop').then(module => process.stdout.write(JSON.stringify(Object.keys(module).sort())))",
    ],
    { cwd: packageDirectory, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`runtime import failed for ${conditions}: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}
