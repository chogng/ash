import type { Plugin } from 'vite';

const requiredMarks = [
	'ash.desktop.contributions-start',
	'ash.desktop.contributions-ready',
	'ash.rendererApi.start',
	'ash.rendererApi.acquire-start',
	'ash.rendererApi.acquired',
	'ash.rendererApi.initialized',
	'ash.rendererApi.workspace-initialized',
	'ash.desktop.open-start',
	'ash.desktop.api-ready',
	'ash.desktop.themes-ready',
	'ash.desktop.workspace-ready',
	'ash.desktop.configuration-ready',
	'ash.desktop.workbench-start',
	'ash.desktop.workbench-created',
	'ash.desktop.lifecycle-ready',
	'ash.workbench.constructor-start',
	'ash.workbench.services-ready',
	'ash.workbench.shell-ready',
	'ash.workbench.sidebar-restore-start',
	'ash.workbench.panel-restore-start',
	'ash.workbench.auxiliary-restore-start',
	'ash.workbench.views-restored',
	'ash.workbench.constructor-done',
	'ash.workbench.restored',
];

/** Trace runs must use a build containing the marks owned by the startup code. */
export function desktopStartupTracePlugin(): Plugin {
	return {
		name: 'ash-desktop-startup-trace',
		apply: 'build',
		generateBundle(_options, bundle) {
			const code = Object.values(bundle).filter(output => output.type === 'chunk').map(chunk => chunk.code).join('\n');
			const missing = requiredMarks.filter(name => !code.includes(name));
			if (missing.length > 0) {
				throw new Error(`Desktop startup marks missing from build: ${missing.join(', ')}`);
			}
		},
	};
}
