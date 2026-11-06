import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function releaseFiles(directory, version, arch) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !['arm64', 'x64'].includes(arch)) throw Error('Invalid release identity');
  return ['dmg', 'zip'].map(extension => {
    const name = `AI-Session-Manager-${version}-mac-${arch}.${extension}`;
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw Error('Expected nonempty regular release artifact');
    return { name, file, size: stat.size };
  });
}

export async function checksums(files) {
  const lines = [];
  for (const { name, file } of files) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    lines.push(`${hash.digest('hex')}  ${name}`);
  }
  return lines.join('\n') + '\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, version, arch] = process.argv.slice(2);
  const files = releaseFiles(directory, version, arch);
  const output = path.join(directory, `SHA256SUMS-${arch}.txt`);
  fs.writeFileSync(output, await checksums(files));
  console.log(JSON.stringify({ files: files.map(({ name, size }) => ({ name, size })), checksums: output }));
}
