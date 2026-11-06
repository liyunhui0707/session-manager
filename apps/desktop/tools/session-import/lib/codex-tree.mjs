import fs from 'node:fs/promises';
import path from 'node:path';
import { YEAR_RE, MONTH_RE, DAY_RE, ROLLOUT_FILE_RE } from './render-codex.mjs';

export function isPathUnder(child, parent) {
  return child === parent || child.startsWith(parent + path.sep);
}

export async function validateAncestorChainCanonical(
  targetPath,
  forbiddenCodexHome,
) {
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
    let real;
    try {
      real = await fs.realpath(anc);
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      throw err;
    }
    if (isPathUnder(real, forbiddenCodexHome)) {
      throw new Error(
        `output path resolves into Codex config tree: ${anc} -> ${real}`,
      );
    }
  }
}

export async function walkSourceTree(canonicalSourceRoot) {
  const candidates = [];
  let skipped = 0;
  let errors = 0;

  let yearEntries;
  try {
    yearEntries = await fs.readdir(canonicalSourceRoot);
  } catch {
    return { candidates, skipped, errors: errors + 1 };
  }
  yearEntries.sort();
  for (const year of yearEntries) {
    if (!YEAR_RE.test(year)) {
      skipped += 1;
      continue;
    }
    const yearPath = path.join(canonicalSourceRoot, year);
    let yearLst;
    try {
      yearLst = await fs.lstat(yearPath);
    } catch {
      errors += 1;
      continue;
    }
    if (yearLst.isSymbolicLink() || !yearLst.isDirectory()) {
      skipped += 1;
      continue;
    }

    let monthEntries;
    try {
      monthEntries = await fs.readdir(yearPath);
    } catch {
      errors += 1;
      continue;
    }
    monthEntries.sort();
    for (const month of monthEntries) {
      if (!MONTH_RE.test(month)) {
        skipped += 1;
        continue;
      }
      const monthPath = path.join(yearPath, month);
      let monthLst;
      try {
        monthLst = await fs.lstat(monthPath);
      } catch {
        errors += 1;
        continue;
      }
      if (monthLst.isSymbolicLink() || !monthLst.isDirectory()) {
        skipped += 1;
        continue;
      }

      let dayEntries;
      try {
        dayEntries = await fs.readdir(monthPath);
      } catch {
        errors += 1;
        continue;
      }
      dayEntries.sort();
      for (const day of dayEntries) {
        if (!DAY_RE.test(day)) {
          skipped += 1;
          continue;
        }
        const dayPath = path.join(monthPath, day);
        let dayLst;
        try {
          dayLst = await fs.lstat(dayPath);
        } catch {
          errors += 1;
          continue;
        }
        if (dayLst.isSymbolicLink() || !dayLst.isDirectory()) {
          skipped += 1;
          continue;
        }

        let fileEntries;
        try {
          fileEntries = await fs.readdir(dayPath);
        } catch {
          errors += 1;
          continue;
        }
        fileEntries.sort();
        for (const fileName of fileEntries) {
          if (!ROLLOUT_FILE_RE.test(fileName)) {
            skipped += 1;
            continue;
          }
          const fileAbs = path.join(dayPath, fileName);
          let fileLst;
          try {
            fileLst = await fs.lstat(fileAbs);
          } catch {
            errors += 1;
            continue;
          }
          if (fileLst.isSymbolicLink() || !fileLst.isFile()) {
            skipped += 1;
            continue;
          }
          candidates.push({
            fileAbs,
            fileName,
            year,
            month,
            day,
            lst: fileLst,
          });
        }
      }
    }
  }

  return { candidates, skipped, errors };
}
