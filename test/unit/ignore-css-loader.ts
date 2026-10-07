import type { LoadHook, ResolveHook } from 'node:module';

export const resolve: ResolveHook = (specifier, context, nextResolve) => {
	if (!specifier.endsWith('.css')) {
		return nextResolve(specifier, context);
	}
	return {
		shortCircuit: true,
		url: new URL(specifier, context.parentURL).href,
	};
};

export const load: LoadHook = (url, context, nextLoad) => {
	if (!url.endsWith('.css')) {
		return nextLoad(url, context);
	}
	return {
		format: 'module',
		shortCircuit: true,
		source: '',
	};
};
