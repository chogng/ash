import { IExtensionService } from '../../extensions/common/extensionService.js';
import { IPathService } from '../../../../platform/path/common/pathService.js';
import { IEditorService } from '../../editor/common/editorService.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { ConfigurationTarget, getConfigValueInTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { IPath } from '../../../../base/common/path.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { OperatingSystem } from '../../../../base/common/platform.js';
import { basename, dirname } from '../../../../base/common/resources.js';
import { CancellationTokenSource, type CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { parseJsonc } from '../../../../base/common/jsonc.js';
import { raceCancellation } from '../../../../base/common/async.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService, FileSystemProviderErrorCode, toFileSystemProviderErrorCode } from '../../../../platform/files/common/files.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService, type IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { ITerminalProcessService } from '../../../../platform/terminal/common/terminal.js';
import { IConfigurationResolverService, executionVariableNames, type ConfiguredInput } from '../common/configurationResolver.js';
import { ConfigurationResolverExpression } from '../common/configurationResolverExpression.js';

/** Workspace stays the sole owner of folder identity; each resolution reads its current folders. */
export class ConfigurationResolverService extends Disposable implements IConfigurationResolverService {
	private readonly contributedVariables = new Map<string, () => Promise<string | undefined>>();
	public get resolvableVariables(): ReadonlySet<string> { return new Set([...executionVariableNames, ...this.contributedVariables.keys()]); }
	private workspaceGeneration = 0;
	private readonly interactions = new Set<CancellationTokenSource>();

	constructor(
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@ICommandService private readonly commands: ICommandService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@ITerminalProcessService private readonly processes: ITerminalProcessService,
		@IPathService private readonly paths: IPathService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		this._register(workspace.onDidChangeWorkspace(() => this.workspaceGeneration++));
		this._register(toDisposable(() => {
			for (const interaction of this.interactions) {
				interaction.cancel();
			}
			this.interactions.clear();
			this.contributedVariables.clear();
		}));
	}

	public contributeVariable(variable: string, resolution: () => Promise<string | undefined>): void {
		this.assertNotDisposed();
		if (this.contributedVariables.has(variable)) throw new Error(localize('configurationResolver.duplicateVariable', "Variable '{0}' is contributed twice.", variable));
		this.contributedVariables.set(variable, resolution);
	}

	public async resolveWithEnvironment(environment: Readonly<Record<string, string | undefined>>, folder: Pick<IWorkspaceFolder, 'uri' | 'name'> | undefined, value: string): Promise<string> {
		const expression = ConfigurationResolverExpression.parse(value);
		await this.resolveNonInteractive(folder, expression, { ...environment });
		return expression.toObject();
	}

	public async resolveAsync<T>(folder: Pick<IWorkspaceFolder, 'uri' | 'name'> | undefined, config: T): Promise<T extends ConfigurationResolverExpression<infer R> ? R : T> {
		const pending = this.createExpression(folder, config);
		const expression = pending instanceof ConfigurationResolverExpression ? pending : await pending;
		await this.resolveNonInteractive(folder, expression);
		return expression.toObject() as T extends ConfigurationResolverExpression<infer R> ? R : T;
	}

	private createExpression<T>(folder: Pick<IWorkspaceFolder, 'uri' | 'name'> | undefined, config: T): ConfigurationResolverExpression<T> | Promise<ConfigurationResolverExpression<T>> {
		if (config instanceof ConfigurationResolverExpression || !config || typeof config !== 'object' || Array.isArray(config)) return ConfigurationResolverExpression.parse(config);
		const input = config as Record<string, unknown>;
		const platforms = ['windows', 'osx', 'linux'];
		if (!platforms.some(key => Object.hasOwn(input, key))) return ConfigurationResolverExpression.parse(config);
		return this.selectPlatformExpression(folder, config);
	}

	private async selectPlatformExpression<T>(folder: Pick<IWorkspaceFolder, 'uri' | 'name'> | undefined, config: T): Promise<ConfigurationResolverExpression<T>> {
		const input = config as Record<string, unknown>;
		const generation = this.workspaceGeneration;
		const os = await this.paths.getOperatingSystem(folder?.uri ?? URI.file('/'));
		this.assertNotDisposed();
		if (generation !== this.workspaceGeneration) throw new CancellationError();
		if (os === undefined) throw new Error(localize('configurationResolver.missingPathPlatform', 'The execution host path platform is unavailable.'));
		const key = os === OperatingSystem.Windows ? 'windows' : os === OperatingSystem.Macintosh ? 'osx' : 'linux';
		const overrides = input[key];
		if (overrides !== undefined && (!overrides || typeof overrides !== 'object' || Array.isArray(overrides))) throw new TypeError(localize('configurationResolver.invalidPlatform', "The '{0}' configuration must be an object.", key));
		// Select before collecting references: another platform must never invoke a command or input.
		const selected = { ...input, ...overrides as Record<string, unknown> };
		for (const platform of ['windows', 'osx', 'linux']) delete selected[platform];
		return ConfigurationResolverExpression.parse(selected as T);
	}

	private async resolveNonInteractive(folder: Pick<IWorkspaceFolder, 'uri' | 'name'> | undefined, expression: ConfigurationResolverExpression<unknown>, environment?: Readonly<Record<string, string | undefined>>, skipContributed = false): Promise<true> {
		const generation = this.workspaceGeneration;
		const attempted = new Set<string>();
		while (true) {
			const references = [...expression.unresolved()].filter(reference => !['command', 'input'].includes(reference.name) && !(skipContributed && this.contributedVariables.has(reference.inner)) && !attempted.has(reference.id));
			if (references.length === 0) return true;
			const resolve = await this.createResolver(folder, new Set(references.map(reference => reference.inner)), environment);
			if (generation !== this.workspaceGeneration) throw new CancellationError();
			for (const reference of references) {
				attempted.add(reference.id);
				const value = resolve(reference.id);
				if (value !== reference.id) expression.resolve(reference, value);
			}
		}
	}

	private async createResolver(folder: Pick<IWorkspaceFolder, 'uri' | 'name'> | undefined, references: ReadonlySet<string>, suppliedEnvironment?: Readonly<Record<string, string | undefined>>): Promise<(value: string) => string> {
		this.assertNotDisposed();
		const generation = this.workspaceGeneration;
		const workspace = this.workspace.getWorkspace();
		const folders = workspace.folders;
		const names = new Set<string>();
		for (const reference of references) {
			if (reference.startsWith('env:')) names.add(reference.slice(4));
		}
		const selected = folder && folders.find(candidate => candidate.uri.toString() === folder.uri.toString());
		// Capture the editor before any host request or interaction yields. A command
		// may change tabs or selection, but this invocation keeps one editor snapshot.
		const editorReferences = [...references].filter(reference => /^(?:file(?:WorkspaceFolder(?:Basename)?|Dirname(?:Basename)?|Extname|Basename(?:NoExtension)?)?|relativeFile(?:Dirname)?|selectedText|lineNumber|columnNumber)(?::|$)/.test(reference));
		const editor = editorReferences.length ? this.instantiation.createInstance(ActiveEditorVariableResolver).snapshot() : undefined;
		if (names.size && folder && !selected) throw new Error(localize('configurationResolver.missingFolder', "Cannot resolve '{0}': open or select the referenced workspace folder.", folder.name));
		if (names.has('')) throw new Error(localize('configurationResolver.missingEnvironmentName', 'An environment variable name is required.'));
		let environment: Readonly<Record<string, string | undefined>> = suppliedEnvironment ?? (names.size ? await this.processes.getEnvironment([...names], folders.length > 1 ? selected?.id : undefined) : {});
		let windowsEnvironment = false;
		if (suppliedEnvironment && names.size) {
			const os = await this.paths.getOperatingSystem(folder?.uri ?? URI.file('/'));
			if (os === undefined) throw new Error(localize('configurationResolver.missingPathPlatform', 'The execution host path platform is unavailable.'));
			windowsEnvironment = os === OperatingSystem.Windows;
			if (windowsEnvironment) environment = Object.fromEntries(Object.entries(environment).map(([key, value]) => [key.toUpperCase(), value]));
		}
		const values = new Map<string, string>();
		const extensions = [...references].some(reference => /^extensionInstallFolder(?::|$)/.test(reference))
			? this.instantiation.createInstance(ExtensionInstallFolderResolver)
			: undefined;
		for (const reference of references) {
			const colon = reference.indexOf(':');
			const variable = colon === -1 ? reference : reference.slice(0, colon);
			const name = colon === -1 ? undefined : reference.slice(colon + 1);
			if (editorReferences.includes(reference)) {
				if (!editor?.resource) throw new Error(localize('configurationResolver.missingEditor', "Cannot resolve '{0}': open a file in the active editor.", reference));
				if (variable === 'selectedText' || variable === 'lineNumber' || variable === 'columnNumber') {
					const value = variable === 'selectedText' ? editor.selectedText : variable === 'lineNumber' ? editor.line : editor.column;
					if (!value) throw new Error(localize('configurationResolver.missingSelection', "Cannot resolve '{0}': select text or a position in the active text editor.", reference));
					values.set(reference, String(value));
				} else {
					const rules = await this.paths.getPath(editor.resource);
					const file = executionPath(editor.resource, rules);
					const directoryResource = dirname(editor.resource);
					const directory = executionPath(directoryResource, rules);
					const filename = basename(editor.resource);
					const extension = rules!.extname(file);
					if (variable === 'relativeFile' || variable === 'relativeFileDirname') {
						const base = name === undefined ? folder : folders.find(candidate => candidate.name === name);
						if (name !== undefined && !base) throw new Error(localize('configurationResolver.missingFolder', "Cannot resolve '{0}': open or select the referenced workspace folder.", reference));
						const target = variable === 'relativeFile' ? file : directory;
						const value = base ? relativeExecutionPath(executionPath(base.uri, rules), target, rules!) : target;
						values.set(reference, variable === 'relativeFileDirname' && !value ? '.' : value);
					} else if (variable === 'fileWorkspaceFolder' || variable === 'fileWorkspaceFolderBasename') {
						const containing = this.workspace.getWorkspaceFolder(editor.resource);
						if (!containing) throw new Error(localize('configurationResolver.missingFileFolder', "Cannot resolve '{0}': the active file does not belong to an open workspace folder.", reference));
						const path = executionPath(containing.uri, rules);
						values.set(reference, variable === 'fileWorkspaceFolder' ? path : basename(containing.uri));
					} else {
						values.set(reference, variable === 'file' ? file : variable === 'fileDirname' ? directory : variable === 'fileDirnameBasename' ? basename(directoryResource) : variable === 'fileExtname' ? extension : variable === 'fileBasename' ? filename : filename.slice(0, filename.length - extension.length));
					}
				}
			} else if (variable === 'extensionInstallFolder') {
				values.set(reference, await extensions!.resolve(name ?? ''));
			} else if (variable === 'config') {
				const value = name && this.configuration.getValue<unknown>(name, { resource: folder?.uri });
				if (!name || !['string', 'number', 'boolean'].includes(typeof value)) throw new Error(localize('configurationResolver.invalidConfiguration', "Cannot resolve configuration '{0}': its value must be a string, number or boolean.", name ?? ''));
				values.set(reference, String(value));
			} else if (variable === 'userHome') {
				const home = this.paths.resolvedUserHome;
				if (!home) throw new Error(localize('configurationResolver.missingHome', 'The execution host user home is unavailable.'));
				values.set(reference, executionPath(home, await this.paths.getPath(home)));
			} else if (variable === 'pathSeparator' || variable === '/') {
				const path = folder ? await this.paths.getPath(folder.uri) : await this.paths.path;
				if (!path) throw new Error(localize('configurationResolver.missingPathPlatform', 'The execution host path platform is unavailable.'));
				values.set(reference, path.sep);
			} else if (variable === 'workspaceFolder' || variable === 'workspaceFolderBasename' || variable === 'workspaceRoot' || variable === 'workspaceRootFolderName' || variable === 'cwd') {
				const selectedFolder = name === undefined ? folder : folders.find(candidate => candidate.name === name);
				if (!selectedFolder) throw new Error(localize('configurationResolver.missingFolder', "Cannot resolve '{0}': open or select the referenced workspace folder.", reference));
				const rules = await this.paths.getPath(selectedFolder.uri);
				const path = executionPath(selectedFolder.uri, rules);
				values.set(reference, variable === 'workspaceFolderBasename' || variable === 'workspaceRootFolderName' ? path.replace(rules!.sep === '\\' ? /[\\/]+$/ : /\/+$/, '').split(rules!.sep === '\\' ? /[\\/]/ : '/').at(-1) ?? '' : path);
			}
		}
		this.assertNotDisposed();
		if (this.workspaceGeneration !== generation) throw new CancellationError();
		return (value: string) => {
			const reference = value.slice(2, -1);
			if (reference === 'env') throw new Error(localize('configurationResolver.missingEnvironmentName', 'An environment variable name is required.'));
			if (reference.startsWith('env:')) {
				const name = windowsEnvironment ? reference.slice(4).toUpperCase() : reference.slice(4);
				if (!name) throw new Error(localize('configurationResolver.missingEnvironmentName', 'An environment variable name is required.'));
				return Object.hasOwn(environment, name) ? environment[name] ?? '' : '';
			}
			return values.get(reference) ?? value;
		};
	}

	public async resolveWithInteractionReplace<T>(folder: Pick<IWorkspaceFolder, 'uri' | 'name'> | undefined, config: T, section?: string, variables?: Readonly<Record<string, string>>, target?: ConfigurationTarget): Promise<(T extends ConfigurationResolverExpression<infer R> ? R : T) | undefined> {
		const expression = await this.resolveInteraction(folder, config, section, variables, target);
		return expression?.toObject() as (T extends ConfigurationResolverExpression<infer R> ? R : T) | undefined;
	}

	public async resolveWithInteraction(folder: Pick<IWorkspaceFolder, 'uri' | 'name'> | undefined, config: unknown, section?: string, variables?: Readonly<Record<string, string>>, target?: ConfigurationTarget): Promise<Map<string, string> | undefined> {
		const expression = await this.resolveInteraction(folder, config, section, variables, target);
		return expression && new Map([...expression.resolved()].map(([reference, result]) => [reference.inner, result.value!]));
	}

	private async resolveInteraction<T>(folder: Pick<IWorkspaceFolder, 'uri' | 'name'> | undefined, config: T, section?: string, variables?: Readonly<Record<string, string>>, target?: ConfigurationTarget): Promise<ConfigurationResolverExpression<T> | undefined> {
		this.assertNotDisposed();
		using interaction = new CancellationTokenSource();
		using listener = this.workspace.onDidChangeWorkspace(() => interaction.cancel());
		this.interactions.add(interaction);
		try {
			const pending = this.createExpression(folder, config);
			const expression = pending instanceof ConfigurationResolverExpression ? pending : await pending;
			const ready = await raceCancellation(this.resolveNonInteractive(folder, expression, undefined, true), interaction.token);
			if (!ready) return undefined;
			const resolved = expression.toObject();
			const references = new Set([...expression.unresolved()]
				.filter(reference => reference.name === 'command' || reference.name === 'input')
				.map(reference => reference.inner));
			if (interaction.token.isCancellationRequested) {
				return undefined;
			}
			// File acquisition and UI dependencies are needed only for configured inputs.
			// This short-lived helper borrows the window's owners; it stores no configuration.
			let inputs = [...references].some(reference => reference.startsWith('input:'))
				? this.instantiation.createInstance(ConfiguredInputResolver)
				: undefined;
			const definitions = inputs
				? await raceCancellation(inputs.load(folder, section, references, target), interaction.token)
				: new Map<string, ConfiguredInput>();
			if (!definitions) return undefined;
			for (const replacement of expression.unresolved()) {
				const contributed = this.contributedVariables.get(replacement.inner);
				if (replacement.name !== 'command' && replacement.name !== 'input' && !contributed) continue;
				const reference = replacement.inner;
				if (interaction.token.isCancellationRequested) {
					return undefined;
				}
				let result: unknown;
				let command = reference;
				if (reference.startsWith('input:')) {
					if (!definitions.has(reference)) {
						inputs ??= this.instantiation.createInstance(ConfiguredInputResolver);
						const added = await raceCancellation(inputs.load(folder, section, new Set([reference]), target), interaction.token);
						if (!added) return undefined;
						for (const [name, definition] of added) definitions.set(name, definition);
					}
					const definition = definitions.get(reference)!;
					if (definition.type === 'command') command = definition.command;
					result = definition.type === 'command'
						? await raceCancellation(this.commands.executeCommand(definition.command, definition.args), interaction.token)
						: await inputs!.show(definition, interaction.token);
				} else if (replacement.name === 'command') {
					const name = reference.slice('command:'.length);
					command = variables && Object.hasOwn(variables, name) ? variables[name]! : name;
					// Commands share the configuration snapshot; nested results use the same resolution cache.
					result = await raceCancellation(this.commands.executeCommand(command, resolved), interaction.token);
				} else {
					result = await raceCancellation(contributed!(), interaction.token);
				}
				if (interaction.token.isCancellationRequested || result === undefined || result === null) {
					return undefined;
				}
				if (typeof result !== 'string') throw commandResultError(command);
				expression.resolve(replacement, reference.startsWith('input:') ? { value: result, input: definitions.get(reference) } : result);
				if (!await raceCancellation(this.resolveNonInteractive(folder, expression, undefined, true), interaction.token)) return undefined;
			}
			if (interaction.token.isCancellationRequested) {
				return undefined;
			}
			return expression;
		} catch (error) {
			if (interaction.token.isCancellationRequested || isCancellationError(error)) return undefined;
			throw error;
		} finally {
			this.interactions.delete(interaction);
		}
	}
}

/** Short-lived lookup; the extension catalog and execution host own identity and paths. */
class ExtensionInstallFolderResolver {
	constructor(
		@IExtensionService private readonly extensions: IExtensionService,
		@IPathService private readonly paths: IPathService,
	) { }

	public async resolve(id: string): Promise<string> {
		const extension = id ? await this.extensions.getExtension(id) : undefined;
		if (!extension?.extensionLocation) throw new Error(localize('configurationResolver.missingExtension', "Cannot resolve extension '{0}': its installation folder is unavailable.", id));
		return executionPath(extension.extensionLocation, await this.paths.getPath(extension.extensionLocation));
	}
}

/** Borrows the editor owners only when execution data needs editor variables. */
class ActiveEditorVariableResolver {
	constructor(
		@IEditorService private readonly editors: IEditorService,
		@ICodeEditorService private readonly codeEditors: ICodeEditorService,
	) { }

	snapshot(): { readonly resource: URI | undefined; readonly selectedText: string | undefined; readonly line: number | undefined; readonly column: number | undefined; } {
		const resource = this.editors.activeEditor?.resource;
		const control = this.codeEditors.getActiveCodeEditor();
		const model = control?.getModel();
		const selection = control?.getSelection();
		const position = control?.getPosition();
		const matches = resource && model?.uri.toString() === resource.toString();
		return { resource, selectedText: matches && selection ? model!.getValueInRange(selection) : undefined, line: matches ? position?.lineNumber : undefined, column: matches ? position?.column : undefined };
	}
}

/** Acquires canonical input definitions and owns each picker until acceptance or cancellation. */
class ConfiguredInputResolver {
	constructor(
		@IFileService private readonly files: IFileService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) { }

	public async load(folder: Pick<IWorkspaceFolder, 'uri' | 'name'> | undefined, section: string | undefined, references: ReadonlySet<string>, target?: ConfigurationTarget): Promise<Map<string, ConfiguredInput>> {
		let definitions: unknown[] | undefined;
		const keys = this.configuration.keys().default;
		if (section && keys.some(key => key === section || key.startsWith(`${section}.`))) {
			const overrides = folder ? { resource: folder.uri } : {};
			// Ash inspects registered keys, while section reads may assemble child keys.
			const inputsKey = keys.includes(`${section}.inputs`) ? `${section}.inputs` : keys.includes(section) ? section : undefined;
			const scoped = target === undefined || inputsKey === undefined ? undefined : getConfigValueInTarget(this.configuration.inspect<unknown>(inputsKey, overrides), target);
			const selected = scoped ?? this.configuration.getValue<unknown>(section, overrides);
			const inputs = inputsKey === `${section}.inputs` && scoped !== undefined ? scoped : selected && typeof selected === 'object' && 'inputs' in selected ? selected.inputs : undefined;
			if (Array.isArray(inputs)) definitions = inputs;
		}
		if (definitions === undefined && folder && (target === undefined || target === ConfigurationTarget.WORKSPACE_FOLDER) && (section === 'tasks' || section === 'launch')) {
			const resource = URI.joinPath(folder.uri, '.vscode', `${section}.json`);
			try {
				const document: unknown = parseJsonc((await this.files.readFile(resource)).content, resource.toString());
				if (document && typeof document === 'object' && 'inputs' in document && Array.isArray(document.inputs)) {
					definitions = document.inputs;
				}
			} catch (error) {
				if (toFileSystemProviderErrorCode(error as Error) !== FileSystemProviderErrorCode.FileNotFound) throw error;
			}
		}
		const selected = new Map<string, ConfiguredInput>();
		for (const reference of references) {
			if (!reference.startsWith('input:')) continue;
			const id = reference.slice('input:'.length);
			const matches = (definitions ?? []).filter(value => value && typeof value === 'object' && 'id' in value && value.id === id);
			if (matches.length !== 1 || !isConfiguredInput(matches[0])) {
				throw new Error(localize('configurationResolver.invalidInput', "Input '{0}' must have one valid definition in the selected workspace's {1}.json.", id, section ?? 'tasks/launch'));
			}
			selected.set(reference, matches[0]);
		}
		return selected;
	}

	public async show(input: Exclude<ConfiguredInput, { type: 'command'; }>, token: CancellationToken): Promise<string | undefined> {
		if (token.isCancellationRequested) return undefined;
		if (input.type === 'promptString') {
			return this.quickInput.input({
				title: input.description,
				placeHolder: input.description,
				value: input.default,
				password: input.password,
			}, token);
		}
		using picker = this.quickInput.createQuickPick<IQuickPickItem & { readonly inputValue: string; }>();
		using listeners = new DisposableStore();
		picker.ariaLabel = input.description;
		picker.placeholder = input.description;
		picker.items = input.options.map(option => {
			const value = typeof option === 'string' ? option : option.value;
			return { label: typeof option === 'string' ? option : option.label ?? value, inputValue: value, picked: value === input.default };
		}).sort((left, right) => Number(right.picked) - Number(left.picked));
		return await new Promise(resolve => {
			listeners.add(picker.onDidAccept(item => {
				resolve(item.inputValue);
				picker.hide();
			}));
			listeners.add(picker.onDidHide(() => resolve(undefined)));
			listeners.add(token.onCancellationRequested(() => picker.hide()));
			picker.show();
		});
	}
}

function isConfiguredInput(value: unknown): value is ConfiguredInput {
	if (!value || typeof value !== 'object' || !('type' in value)) return false;
	if (value.type === 'command') {
		return 'command' in value && typeof value.command === 'string' && value.command.length > 0;
	}
	if (!('description' in value) || typeof value.description !== 'string' || ('default' in value && typeof value.default !== 'string')) {
		return false;
	}
	if (value.type === 'promptString') return !('password' in value) || typeof value.password === 'boolean';
	if (value.type !== 'pickString' || !('options' in value) || !Array.isArray(value.options) || value.options.length === 0) return false;
	return value.options.every(option => typeof option === 'string' || (
		option && typeof option === 'object' && typeof option.value === 'string' &&
		(option.label === undefined || typeof option.label === 'string')
	));
}

function commandResultError(command: string): Error {
	return new Error(localize('configurationResolver.commandResult', "Command '{0}' must return a string to resolve a configuration variable.", command));
}

registerSingleton(IConfigurationResolverService, ConfigurationResolverService, InstantiationType.Delayed);


/** URI.fsPath follows the renderer OS; execution paths follow the resource owner. */
function executionPath(resource: URI, path: IPath | undefined): string {
	if (!path) throw new Error(localize('configurationResolver.missingPathPlatform', 'The execution host path platform is unavailable.'));
	let value = resource.authority && resource.scheme === Schemas.file ? `//${resource.authority}${resource.path}` : resource.path;
	if (resource.scheme === Schemas.file && /^\/[a-z]:/i.test(value)) value = (path.sep === '\\' ? value[1]!.toUpperCase() : value[1]!.toLowerCase()) + value.slice(2);
	return path.sep === '\\' ? value.replaceAll('/', '\\') : value;
}

/** Both inputs are absolute paths obtained from canonical resources on the execution host. */
function relativeExecutionPath(from: string, to: string, rules: IPath): string {
	const windows = rules.sep === '\\';
	const normalize = (value: string): string => rules.normalize(value).replaceAll(rules.sep, '/').replace(/\/+$/, '');
	const base = normalize(from);
	const target = normalize(to);
	const root = (value: string): string => windows ? (/^\/\/[^/]+\/[^/]+/.exec(value)?.[0] ?? /^[a-z]:/i.exec(value)?.[0] ?? '/') : '/';
	const equal = (left: string, right: string): boolean => windows ? left.toLowerCase() === right.toLowerCase() : left === right;
	if (!equal(root(base), root(target))) return to;
	const left = base.split('/').filter(Boolean);
	const right = target.split('/').filter(Boolean);
	let shared = 0;
	while (shared < left.length && shared < right.length && equal(left[shared]!, right[shared]!)) shared++;
	return [...left.slice(shared).map(() => '..'), ...right.slice(shared)].join(rules.sep);
}
