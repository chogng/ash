import { resolve } from 'node:path';
import { withProcessRun } from '../../build/processes.ts';
import { parseFixtureArguments, runComponentFixtures } from './cssOrderShared.mts';

const request = parseFixtureArguments(process.argv.slice(2));
await withProcessRun(resolve(import.meta.dirname, '../..'), (run, environment) =>
	runComponentFixtures(run, environment, request),
);
