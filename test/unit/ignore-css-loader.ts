import type { LoadHook, ResolveHook } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

export const resolve: ResolveHook = (specifier, context, nextResolve) => {
	if (specifier.startsWith('ash:editor/')) {
		specifier = pathToFileURL(
			resolvePath(
				process.env.ASH_UNIT_TEST_OUTPUT_DIRECTORY ??
					resolvePath(import.meta.dirname, '../../.build/desktop/test'),
				'src/ash',
				specifier.slice('ash:editor/'.length),
			),
		).href;
	}
	if (!specifier.endsWith('.css')) {
		return nextResolve(specifier, context);
	}
	return { shortCircuit: true, url: new URL(specifier, context.parentURL).href };
};

export const load: LoadHook = (url, context, nextLoad) => {
	if (!url.endsWith('.css')) {
		return nextLoad(url, context);
	}
	return { format: 'module', shortCircuit: true, source: '' };
};
