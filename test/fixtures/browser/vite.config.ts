import { globSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { resolve } from "node:path";
import { defineConfig, normalizePath, type Plugin } from "vite";
import { rendererOutput } from '../../../build/desktop/vite/rendererOutput.js';
import { rendererDependencyAliases } from '../../../build/desktop/vite/rendererDependencies.js';
import { workbenchEntryPlugin } from '../../../build/desktop/vite/workbenchEntryPlugin.js';
import { webUpdatePlugin } from '../../../build/desktop/vite/webUpdatePlugin.js';

// The comparison harness stays current; product modules resolve into the Git
// baseline without copying fixtures or mutating either checkout's sources.
function fixtureBaselineSources(): Plugin {
	const sourceRoot = normalizePath(resolve(import.meta.dirname, '../../../src/ash'));
	const baseline = process.env.ASH_COMPONENT_FIXTURE_SOURCE_ROOT;
	return {
		name: 'fixture-baseline-sources', enforce: 'pre',
		async resolveId(source, importer) {
			if (!baseline) return;
			const resolved = await this.resolve(source, importer, { skipSelf: true });
			if (!resolved || !resolved.id.startsWith(`${sourceRoot}/`)) return;
			const path = resolved.id.slice(sourceRoot.length + 1);
			if (path.startsWith('test/') || path.includes('/test/')) return;
			return { ...resolved, id: `${normalizePath(baseline)}/${path}` };
		},
	};
}

const root = resolve(import.meta.dirname, '../../..');
const fixturePages = [
	...globSync('src/ash/**/test/**/fixtures/*.html', { cwd: root }),
	...globSync('test/fixtures/browser/*.html', { cwd: root }),
	...globSync('test/componentFixtures/*.html', { cwd: root }),
	...globSync('test/integration/browser/**/*.html', { cwd: root }),
];
const themePreviewPages = [{
	url: '/browser/theme-preview/themePreview.html',
	inputFile: resolve(root, 'test/integration/browser/browser/theme-preview/themePreview.html'),
	sourceFile: resolve(import.meta.dirname, '../../../src/ash/workbench/contrib/themeEditor/browser/themePreview.html'),
}, {
	url: '/browser/theme-preview/sessionsThemePreview.html',
	inputFile: resolve(root, 'test/integration/browser/browser/theme-preview/sessionsThemePreview.html'),
	sourceFile: resolve(import.meta.dirname, '../../../src/ash/sessions/contrib/themeEditor/browser/sessionsThemePreview.html'),
}];

// Fixture URLs are independent of their source owner. Keep existing browser drivers stable.
function fixturePageUrls(): Plugin {
	return {
		name: 'fixture-page-urls',
		writeBundle(options, bundle) {
			const directory = resolve(options.dir!);
			for (const [key, output] of Object.entries(bundle)) {
				if (output.type !== 'asset' || !key.endsWith('.html')) continue;
				const name = basename(key);
				if (key !== name) writeFileSync(resolve(directory, name), output.source);
				if (key.includes('/browser/theme-preview/')) {
					const alias = 'browser/theme-preview/' + name;
					mkdirSync(resolve(directory, 'browser/theme-preview'), { recursive: true });
					writeFileSync(resolve(directory, alias), output.source);
				}
			}
		},
	};
}

export default defineConfig({
	define: {
		__ASH_WEB_APP_SERVER__: 'false',
		'import.meta.env.ASH_BUILTIN_THEME_SOURCES': JSON.stringify({ 'vscode.theme-defaults': 'file:///extension-sources/theme-defaults' }),
	},
	// Fixtures use plain CSS; keep dev transforms independent of ancestor PostCSS config discovery.
	css: { postcss: { plugins: [] } },
	resolve: { alias: [{ find: /^ash:editor\//u, replacement: resolve(import.meta.dirname, '../../../src/ash') + '/' }, ...rendererDependencyAliases] },
	root,
	plugins: [fixturePageUrls(), fixtureBaselineSources(), webUpdatePlugin(), workbenchEntryPlugin('/themeEditor.html', [...fixturePages.map(path => ({
		url: '/' + basename(path), inputFile: resolve(root, path), sourceFile: resolve(root, path),
	})), ...themePreviewPages])],
	server: {
		host: "127.0.0.1", port: 5185, strictPort: true,
		// The repository root also contains large build trees, which are not fixture inputs.
		watch: { ignored: ['**/.build/**', '**/.tmp/**', '**/target/**', '**/bazel-*/**'] },
	},
	build: {
		outDir: resolve(import.meta.dirname, "../../../.build/desktop/editor-browser"),
		emptyOutDir: true,
		rolldownOptions: {
			output: rendererOutput,
			input: Object.fromEntries([
				...fixturePages.map(path => [basename(path, '.html'), resolve(root, path)]),
				...themePreviewPages.map(page => [basename(page.inputFile, '.html'), page.inputFile]),
			]),
		},
	},
});
