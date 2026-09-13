import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { desktopBuildPath } from '../../../build/lib/paths.ts';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
await rm(desktopBuildPath(repositoryRoot, 'test'), { recursive: true, force: true });
