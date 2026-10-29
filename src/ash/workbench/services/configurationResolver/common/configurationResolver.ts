import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import type { ConfigurationResolverExpression } from './configurationResolverExpression.js';
import type { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';

export const IConfigurationResolverService = createServiceIdentifier<IConfigurationResolverService>('configurationResolverService');

/** Names shared by execution resolution and task configuration validation. */
export const executionVariableNames: ReadonlySet<string> = new Set(['workspaceFolder', 'workspaceFolderBasename', 'workspaceRoot', 'workspaceRootFolderName', 'env', 'command', 'input', 'config', 'userHome', 'cwd', 'pathSeparator', '/', 'file', 'fileWorkspaceFolder', 'fileWorkspaceFolderBasename', 'relativeFile', 'relativeFileDirname', 'fileDirname', 'fileDirnameBasename', 'fileExtname', 'fileBasename', 'fileBasenameNoExtension', 'selectedText', 'lineNumber', 'columnNumber', 'extensionInstallFolder']);

export function isExecutionVariable(reference: string): boolean {
	if (/[{}]/.test(reference)) return false;
	const separator = reference.indexOf(':');
	const name = separator === -1 ? reference : reference.slice(0, separator);
	if (!executionVariableNames.has(name)) return false;
	if (['env', 'command', 'input', 'config', 'extensionInstallFolder'].includes(name)) return separator !== -1 && reference.length > separator + 1;
	return separator === -1 || ['workspaceFolder', 'workspaceFolderBasename', 'workspaceRoot', 'workspaceRootFolderName', 'cwd', 'relativeFile', 'relativeFileDirname'].includes(name) && reference.length > separator + 1;
}

/** Resolves execution data without changing the source configuration. */
export interface IConfigurationResolverService {
	readonly resolvableVariables: ReadonlySet<string>;
	resolveWithEnvironment(environment: Readonly<Record<string, string | undefined>>, folder: Pick<IWorkspaceFolder, 'uri' | 'name'> | undefined, value: string): Promise<string>;
	resolveAsync<T>(folder: Pick<IWorkspaceFolder, 'uri' | 'name'> | undefined, config: T): Promise<T extends ConfigurationResolverExpression<infer R> ? R : T>;
	/** Resolves command and configured input variables once per invocation; undefined means cancellation. */
	resolveWithInteractionReplace<T>(folder: Pick<IWorkspaceFolder, 'uri' | 'name'> | undefined, config: T, section?: string, variables?: Readonly<Record<string, string>>, target?: ConfigurationTarget): Promise<(T extends ConfigurationResolverExpression<infer R> ? R : T) | undefined>;
	resolveWithInteraction(folder: Pick<IWorkspaceFolder, 'uri' | 'name'> | undefined, config: unknown, section?: string, variables?: Readonly<Record<string, string>>, target?: ConfigurationTarget): Promise<Map<string, string> | undefined>;
	contributeVariable(variable: string, resolution: () => Promise<string | undefined>): void;
}

/** Input definitions belong to the selected workspace's tasks.json or launch.json. */
export type ConfiguredInput =
	| { readonly id: string; readonly type: 'promptString'; readonly description: string; readonly default?: string; readonly password?: boolean; }
	| { readonly id: string; readonly type: 'pickString'; readonly description: string; readonly options: readonly (string | { readonly value: string; readonly label?: string; })[]; readonly default?: string; }
	| { readonly id: string; readonly type: 'command'; readonly command: string; readonly args?: unknown; };
