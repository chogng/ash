import { localize } from '../../../../nls.js';
import type { IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';

export interface ITaskEntry extends IQuickPickItem {
	readonly autoDetect: boolean;
	readonly content: string;
}

/** Templates are editable launch configuration, never automatically executed commands. */
export function getTemplates(): ITaskEntry[] {
	const content = (label: string, command: string, args: readonly string[] = []): string =>
		JSON.stringify({ version: '2.0.0', tasks: [{ label, type: 'shell', command, args, problemMatcher: [] }] }, null, '\t') + '\n';
	return [
		{
			label: 'npm',
			description: localize('tasks.template.npm', 'Run the package build script'),
			autoDetect: true,
			content: content('build', 'npm', ['run', 'build']),
		},
		{
			label: '.NET Core',
			description: localize('tasks.template.dotnet', 'Build the current .NET project'),
			autoDetect: false,
			content: content('build', 'dotnet', ['build']),
		},
		{
			label: 'TypeScript',
			description: localize('tasks.template.typescript', 'Build the current TypeScript project'),
			autoDetect: true,
			content: content('build', 'npx', ['tsc', '-b']),
		},
		{
			label: localize('tasks.template.others', 'Others'),
			description: localize('tasks.template.shell', 'Create a task for an external command'),
			autoDetect: false,
			content: content('example', 'echo', ['Hello']),
		},
	];
}
