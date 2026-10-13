import { resolve } from 'node:path';
import { prepareIncrementalOutput } from '../../build/lib/incrementalOutput.ts';

const [project, ...extra] = process.argv.slice(2);
if (extra.length || !['tsconfig.test.json', 'tsconfig.extensions-test.json'].includes(project)) {
	throw new Error('Usage: prepare.ts <tsconfig.test.json|tsconfig.extensions-test.json>');
}
await prepareIncrementalOutput(resolve(import.meta.dirname, '../..', project));
