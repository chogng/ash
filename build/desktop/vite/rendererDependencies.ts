import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

// The published LiveKit bundle is one indivisible module larger than our chunk budget.
// Build its shipped source modules so the renderer can split protocol, media and crypto.
export const rendererDependencyAliases = [{
	find: /^livekit-client$/u,
	replacement: resolve(dirname(createRequire(import.meta.url).resolve('livekit-client')), '../src/index.ts'),
}];
