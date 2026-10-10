import { copyFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('../../../', import.meta.url));
const output = fileURLToPath(new URL('../../../.build/sdk/typescript', import.meta.url));
const result = spawnSync('pnpm', ['--dir', app, 'exec', 'tsc', '-p', 'sdk/typescript/tsconfig.json', '--noEmit', 'false', '--outDir', output], { stdio: 'inherit' });
if (result.error) { throw result.error; }
if (result.status !== 0) { process.exit(result.status ?? 1); }
mkdirSync(`${output}/.ash-plugin`, { recursive: true });
copyFileSync(new URL('./.ash-plugin/plugin.json', import.meta.url), `${output}/.ash-plugin/plugin.json`);
