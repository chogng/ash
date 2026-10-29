import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { Plugin } from 'vite';

/** Publishes one deployment identity shared by the served pages and the update probe. */
export function webUpdatePlugin(): Plugin {
	return {
		name: 'ash-web-update',
		apply: 'build',
		enforce: 'post',
		generateBundle: {
			order: 'post',
			handler(_options, bundle) {
				// Hash before stamping HTML. Chunk/asset names also capture imported images, fonts and WASM.
				const outputs = Object.values(bundle)
					.filter(output => output.type === 'chunk' || /\.(?:html|css)$/u.test(output.fileName))
					.sort((left, right) => left.fileName.localeCompare(right.fileName));
				const hash = createHash('sha256');
				for (const output of outputs) {
					hash.update(output.fileName).update('\0');
					hash.update(output.type === 'chunk' ? output.code : output.source).update('\0');
				}
				const version = hash.digest('hex');
				for (const output of outputs) {
					if (output.type !== 'asset' || !output.fileName.endsWith('.html')) continue;
					const source =
						typeof output.source === 'string' ? output.source : new TextDecoder().decode(output.source);
					const manifest = posix.relative(posix.dirname(output.fileName), 'web-version.json');
					output.source = source.replace(
						/<head\b[^>]*>/iu,
						head =>
							`${head}\n\t\t<meta name="ash-web-build" content="${version}" data-version-url="${manifest}" />`,
					);
				}
				this.emitFile({ type: 'asset', fileName: 'web-version.json', source: JSON.stringify({ version }) });
			},
		},
	};
}
