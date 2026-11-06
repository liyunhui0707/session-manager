import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export function expandHome(p) {
  if (p === '~') return os.homedir();
  if (typeof p === 'string' && p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export function isForbiddenPath(p) {
  return p === '/' || p === os.homedir();
}

export function assertSafeInt(name, value, { min, max }) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value)
  ) {
    throw new Error(`${name} must be an integer, got: ${JSON.stringify(value)}`);
  }
  if (value < min || value > max) {
    throw new Error(`${name} must be in [${min}, ${max}], got: ${value}`);
  }
}

export async function validateAncestorChain(targetPath) {
  const norm = path.resolve(targetPath);
  const chain = [];
  let cur = norm;
  while (true) {
    chain.unshift(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  for (const anc of chain) {
    let lst;
    try {
      lst = await fs.lstat(anc);
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      throw err;
    }
    if (lst.isSymbolicLink()) {
      throw new Error(`output ancestor is a symlink: ${anc}`);
    }
  }
}

export async function resolveSourceRoot(sourceRoot) {
  if (typeof sourceRoot !== 'string' || sourceRoot.length === 0) {
    throw new Error('sourceRoot must be a non-empty string');
  }
  const resolved = path.resolve(expandHome(sourceRoot));
  if (isForbiddenPath(resolved)) {
    throw new Error(`sourceRoot must not be ${resolved}`);
  }
  let srcLst;
  try {
    srcLst = await fs.lstat(resolved);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { noSource: true, resolved };
    }
    throw err;
  }
  if (srcLst.isSymbolicLink()) {
    throw new Error('sourceRoot must not be a symlink');
  }
  if (!srcLst.isDirectory()) {
    throw new Error('sourceRoot must be a directory');
  }
  const canonical = await fs.realpath(resolved);
  if (isForbiddenPath(canonical)) {
    throw new Error(
      `sourceRoot realpath resolves to forbidden path: ${canonical}`,
    );
  }
  const container = path.dirname(canonical);
  const containerIsHidden = path.basename(container).startsWith('.');
  return { noSource: false, resolved, canonical, container, containerIsHidden };
}

export function preResolveOutputBase(outputBase) {
  if (typeof outputBase !== 'string' || outputBase.length === 0) {
    throw new Error('outputBase must be a non-empty string');
  }
  const resolved = path.resolve(expandHome(outputBase));
  if (isForbiddenPath(resolved)) {
    throw new Error(`outputBase must not be ${resolved}`);
  }
  return resolved;
}

export async function resolveOutputBase(
  resolved,
  { container, containerIsHidden },
) {
  if (containerIsHidden) {
    if (
      resolved === container ||
      resolved.startsWith(container + path.sep)
    ) {
      throw new Error('outputBase must not be inside source container');
    }
  }
  await validateAncestorChain(resolved);

  let lst = null;
  try {
    lst = await fs.lstat(resolved);
  } catch (err) {
    if (!(err && err.code === 'ENOENT')) throw err;
  }
  if (lst) {
    if (lst.isSymbolicLink()) {
      throw new Error('outputBase exists as a symlink');
    }
    if (!lst.isDirectory()) {
      throw new Error('outputBase exists but is not a directory');
    }
  } else {
    await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
  }
  const canonical = await fs.realpath(resolved);
  if (containerIsHidden) {
    if (
      canonical === container ||
      canonical.startsWith(container + path.sep)
    ) {
      throw new Error('outputBase realpath inside source container');
    }
  }
  if (isForbiddenPath(canonical)) {
    throw new Error(`outputBase realpath is forbidden: ${canonical}`);
  }
  return canonical;
}
