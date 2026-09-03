/**
 * Pure package-manifest checks shared by the tarball verifier and its unit
 * tests. Keeping target collection separate makes it impossible for the
 * executable check to accidentally skip a nested `exports.*.types` target.
 */
export function collectLocalTargets(value, targets = []) {
  if (typeof value === 'string') {
    if (value.startsWith('./')) targets.push(value.slice(2));
    return targets;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectLocalTargets(entry, targets);
    return targets;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) collectLocalTargets(entry, targets);
  }
  return targets;
}

export function assertPackedTargets(manifest, packedFiles) {
  const localTargets = collectLocalTargets({
    main: manifest.main,
    module: manifest.module,
    types: manifest.types,
    bin: manifest.bin,
    exports: manifest.exports,
  });
  for (const target of localTargets) {
    if (!packedFiles.has(target)) {
      throw new Error(`${manifest.name}: packed entry target '${target}' is missing`);
    }
  }
  return localTargets;
}
