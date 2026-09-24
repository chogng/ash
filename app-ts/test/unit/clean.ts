import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { appTsBuildPath } from '../../../build/app_ts/paths.ts';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
await rm(appTsBuildPath(repositoryRoot, 'test'), { recursive: true, force: true });
