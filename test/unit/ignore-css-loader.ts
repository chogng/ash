import type { LoadHookSync, ResolveHookSync } from 'node:module';
import { relative, resolve as resolvePath } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const cssModule = /\.css(?:\?inline)?$/;

export const resolve: ResolveHookSync = (specifier, context, nextResolve) => {
	if (specifier.startsWith('ash:editor/')) {
		specifier = pathToFileURL(resolvePath(process.env.ASH_UNIT_TEST_OUTPUT_DIRECTORY ?? resolvePath(import.meta.dirname, '../../.build/desktop/test'), 'src/ash', specifier.slice('ash:editor/'.length))).href;
	}
	if (!cssModule.test(specifier)) {
		return nextResolve(specifier, context);
	}
	return {
		shortCircuit: true,
		url: new URL(specifier, context.parentURL).href,
	};
};

export const load: LoadHookSync = (url, context, nextLoad) => {
	if (!cssModule.test(url)) {
		return nextLoad(url, context);
	}
	if (url.endsWith('?inline')) {
		const emitted = fileURLToPath(url);
		const repository = resolvePath(import.meta.dirname, '../..');
		const output = process.env.ASH_UNIT_TEST_OUTPUT_DIRECTORY ?? resolvePath(repository, '.build/desktop/test');
		const source = existsSync(emitted) ? emitted : resolvePath(repository, relative(output, emitted));
		return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(readFileSync(source, 'utf8'))};` };
	}
	return {
		format: 'module',
		shortCircuit: true,
		source: '',
	};
};
