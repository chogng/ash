import { resolve } from 'node:path';
import type { Plugin } from 'vite';

interface StartupMark {
	readonly name: string;
	readonly anchor: string;
	readonly position: 'before' | 'after';
}

// Exact source anchors keep measurement points together and make a renamed startup step fail the trace build.
const marksByFile: Readonly<Record<string, readonly StartupMark[]>> = {
	'src/ash/code/electron-browser/workbench/workbench.ts': [
		{ name: 'ash.desktop.trace-build-v1', anchor: 'await modeLoaders[modeId]();', position: 'before' },
		{ name: 'ash.desktop.contributions-start', anchor: 'await modeLoaders[modeId]();', position: 'before' },
	],
	'src/ash/code/electron-browser/workbench/modes/code.ts': [
		{ name: 'ash.desktop.contributions-ready', anchor: 'await main(WorkbenchModeId.Code, [createAppServerDebugAdapterCapability]);', position: 'before' },
	],
	'src/ash/code/electron-browser/workbench/modes/academic.ts': [
		{ name: 'ash.desktop.contributions-ready', anchor: 'await main(WorkbenchModeId.Academic);', position: 'before' },
	],
	'src/ash/platform/app-server/common/generated/AppServerProtocolDecoder.ts': [
		{ name: 'ash.decoder.schema-start', anchor: 'const protocolSchema = JSON.parse(', position: 'before' },
		{ name: 'ash.decoder.schema-ready', anchor: 'export class AppServerProtocolDecodeError extends Error {', position: 'before' },
	],
	'src/ash/platform/native/electron-browser/rendererApi.ts': [
		{ name: 'ash.rendererApi.start', anchor: '\tconst resources = new DisposableStore();', position: 'before' },
		{ name: 'ash.rendererApi.acquire-start', anchor: '\t\tconst enabled = await transport.acquire();', position: 'before' },
		{ name: 'ash.rendererApi.acquired', anchor: '\t\tconst enabled = await transport.acquire();', position: 'after' },
		{ name: 'ash.rendererApi.initialized', anchor: '\t\tif (enabled) {\n\t\t\tawait initialize();', position: 'after' },
		{ name: 'ash.rendererApi.workspace-initialized', anchor: '\t\t\tawait initializeWorkspace(client, workspaceTrust);', position: 'after' },
	],
	'src/ash/workbench/electron-browser/desktop.main.ts': [
		{ name: 'ash.desktop.open-start', anchor: '\t\tthis.opened = true;', position: 'after' },
		{ name: 'ash.desktop.api-ready', anchor: '\t\t\tprofileServices.registerInstance(IFileService, api.localFiles);', position: 'before' },
		{ name: 'ash.desktop.themes-ready', anchor: '\t\t\tconst workspace = parseWorkspace(await api.workspace.getWorkspace());', position: 'before' },
		{ name: 'ash.desktop.workspace-ready', anchor: '\t\t\tconst workspace = parseWorkspace(await api.workspace.getWorkspace());', position: 'after' },
		{ name: 'ash.desktop.configuration-ready', anchor: '\t\t\tconst initialConfigurationSnapshot = validateConfigurationSnapshot(await api.configuration.read());', position: 'after' },
		{ name: 'ash.desktop.workbench-start', anchor: '\t\t\tconst workbench = this._register(await startWorkbench({', position: 'before' },
		{ name: 'ash.desktop.workbench-created', anchor: '\t\t\tconst subscription = api.workspace.onDidChange(workspace => {', position: 'before' },
		{ name: 'ash.desktop.lifecycle-ready', anchor: '\t\t\tawait lifecycleService.initialize();', position: 'after' },
	],
	'src/ash/workbench/browser/workbench.ts': [
		{ name: 'ash.workbench.constructor-start', anchor: '\t\tthis._register(FormattingConflicts.setFormatterSelector(async formatters => formatters[0]));', position: 'before' },
		{ name: 'ash.workbench.services-ready', anchor: '\t\tcontributions.advance(WorkbenchPhase.BlockStartup);', position: 'before' },
		{ name: 'ash.workbench.shell-ready', anchor: '\t\tthis.restoreActiveViewContainers();', position: 'before' },
		{ name: 'ash.workbench.sidebar-restore-start', anchor: '\t\t\topenSidebarComposite(requiredViewContainerToRestore(', position: 'before' },
		{ name: 'ash.workbench.panel-restore-start', anchor: '\t\t\topenPanelComposite(requiredViewContainerToRestore(', position: 'before' },
		{ name: 'ash.workbench.auxiliary-restore-start', anchor: '\t\t\topenAuxiliaryComposite(requiredViewContainerToRestore(', position: 'before' },
		{ name: 'ash.workbench.views-restored', anchor: '\t\tthis.restoreActiveViewContainers();', position: 'after' },
		{ name: 'ash.workbench.constructor-done', anchor: '\t\tthis.whenRestored = this.completeStartupRestoration([extensionReady, recentWorkspaces.initialize(), ...serviceContributionReady], workingCopyBackups, editor, editorParts, contributions, saveFontInfo);', position: 'after' },
	],
};

export function desktopStartupTracePlugin(desktopRoot: string): Plugin {
	const marksByPath = new Map(Object.entries(marksByFile).map(([path, marks]) => [resolve(desktopRoot, path).replaceAll('\\', '/'), marks]));
	return {
		name: 'ash-desktop-startup-trace',
		apply: 'build',
		enforce: 'pre',
		transform(code, id) {
			const path = id.split('?')[0]!.replaceAll('\\', '/');
			const marks = marksByPath.get(path);
			if (!marks) return;
			// Checkout line endings must not change startup measurement boundaries or insertion offsets.
			const source = code.replaceAll('\r\n', '\n');
			const insertions = marks.map(mark => {
				const start = source.indexOf(mark.anchor);
				if (start < 0 || source.indexOf(mark.anchor, start + 1) >= 0) {
					throw new Error(`Desktop startup trace anchor is missing or ambiguous: ${path} ${mark.name}`);
				}
				const offset = start + (mark.position === 'after' ? mark.anchor.length : 0);
				return { offset, text: mark.position === 'before' ? `performance.mark('${mark.name}');\n` : `\nperformance.mark('${mark.name}');` };
			});
			let transformed = source;
			for (const insertion of insertions.sort((left, right) => right.offset - left.offset)) {
				transformed = transformed.slice(0, insertion.offset) + insertion.text + transformed.slice(insertion.offset);
			}
			return { code: transformed, map: null };
		},
	};
}
