/** Optional read-only render metrics from the installed xterm; every access has a public fallback. */
export interface IXtermCore {
	readonly _renderService?: {
		readonly dimensions?: {
			readonly css?: {
				readonly cell?: { readonly width: number; readonly height: number; };
			};
		};
	};
}
