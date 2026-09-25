import { resolve } from "node:path";
import { defineConfig } from "vite";
import { rendererOutput } from '../../../../build/app_ts/vite/rendererOutput.js';

export default defineConfig({
	root: resolve(import.meta.dirname),
	server: { host: "127.0.0.1", port: 5185, strictPort: true },
	build: {
		outDir: resolve(import.meta.dirname, "../../../../.build/app-ts/editor-browser"),
		emptyOutDir: true,
		rolldownOptions: {
			output: rendererOutput,
			input: {
				tokenization: resolve(import.meta.dirname, 'tokenization.html'),
				diff: resolve(import.meta.dirname, 'diff.html'),
				language: resolve(import.meta.dirname, "language.html"),
				marketplace: resolve(import.meta.dirname, "marketplace.html"),
				advisor: resolve(import.meta.dirname, "advisor.html"),
				markdown: resolve(import.meta.dirname, 'markdown.html'),
				themes: resolve(import.meta.dirname, "themes.html"),
				webTransport: resolve(import.meta.dirname, 'webTransport.html'),
				dialog: resolve(import.meta.dirname, "dialog.html"),
				onboarding: resolve(import.meta.dirname, 'onboarding.html'),
				releaseNotes: resolve(import.meta.dirname, 'releaseNotes.html'),
				terminal: resolve(import.meta.dirname, "terminal.html"),
				textModel: resolve(import.meta.dirname, "textModel.html"),
				standalone: resolve(import.meta.dirname, 'standalone.html'),
				gpuText: resolve(import.meta.dirname, "gpuText.html"),
				academic: resolve(import.meta.dirname, "academic.html"),
			},
		},
	},
});
