import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { compile, compilationTargets, prepareCompilation } from './lib/compilation.ts';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--prepare') {
  await prepareCompilation();
} else {
  const targets = compilationTargets(args);
  await compile(targets);
  if (targets.includes('renderer')) {
    const root = resolve(import.meta.dirname, '..');
    const child = spawn(process.execPath, [resolve(root, 'build/node_modules/vite/bin/vite.js'), 'build', '--config', resolve(root, 'build/vite/vite.config.ts')], {
      cwd: resolve(root, 'ash-ts'), stdio: 'inherit', windowsHide: true,
    });
    child.once('error', error => { console.error(error); process.exitCode = 1; });
    child.once('exit', code => { process.exitCode = code ?? 1; });
  }
}
