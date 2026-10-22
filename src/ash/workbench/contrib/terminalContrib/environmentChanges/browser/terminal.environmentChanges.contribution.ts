import { Event } from '../../../../../base/common/event.js';
import { escapeMarkdownSyntaxTokens } from '../../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { OperatingSystem } from '../../../../../base/common/platform.js';
import Severity from '../../../../../base/common/severity.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { MarshalledId } from '../../../../../base/common/marshallingIds.js';
import { onUnexpectedError } from '../../../../../base/common/errors.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import type { ITextModel } from '../../../../../editor/common/model.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { EnvironmentVariableMutatorType, type EnvironmentVariableScope, type IMergedEnvironmentVariableCollection } from '../../../../../platform/terminal/common/environmentVariable.js';
import { MergedEnvironmentVariableCollection } from '../../../../../platform/terminal/common/environmentVariableCollection.js';
import { ITerminalProcessService } from '../../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ITerminalService, type ITerminalContribution, type ITerminalInstance } from '../../../terminal/browser/terminal.js';
import { registerTerminalContribution, type ITerminalContributionContext } from '../../../terminal/browser/terminalExtensions.js';
import { IEnvironmentVariableService } from '../../../terminal/common/environmentVariable.js';
import { TerminalCommandId } from '../../../terminal/common/terminal.js';
import { TerminalHasActiveInstanceContext } from '../../../terminal/common/terminalContextKey.js';

const statusId = 'environment-changes';

/** Projects extension changes into the terminal's existing status list. */
export class TerminalEnvironmentChangesContribution extends Disposable implements ITerminalContribution {
	constructor(
		private readonly context: ITerminalContributionContext,
		@IEnvironmentVariableService private readonly environment: IEnvironmentVariableService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@ITerminalProcessService private readonly processes: ITerminalProcessService,
		@ICommandService private readonly commands: ICommandService,
	) {
		super();
		this._register(environment.onDidChangeCollections(() => this.update()));
		this._register(context.instance.onDidChangeState(() => this.update()));
		this.update();
	}

	private update(): void {
		const instance = this.context.instance;
		instance.statusList?.remove(statusId);
		const snapshot = instance.extEnvironmentVariableCollection;
		const scope = { workspaceFolder: this.workspace.getWorkspace().folders.find(folder => folder.id === instance.dirId) };
		const current = currentCollection(instance, this.environment, this.processes);
		if (!snapshot) {
			if (current.getVariableMap(scope).size) instance.statusList?.add({
				id: statusId, severity: Severity.Info,
				tooltip: localize('terminal.environmentChanges.unknownStatus', 'This process has no retained extension environment snapshot. Show Environment Contributions lists future configuration separately.')
			});
			return;
		}
		if (snapshot.diff(current, scope)) instance.statusList?.add({
			id: statusId, severity: Severity.Warning,
			tooltip: localize('terminal.environmentChanges.changedSummary', 'Extensions changed this terminal’s environment contributions. Relaunch to apply them.'),
			detailedTooltip: localize('terminal.environmentChanges.changedStatus', 'Extensions changed this terminal’s environment contributions. Relaunch the terminal to apply the current contributions; Show Environment Contributions opens the details.'),
			hoverActions: !instance.isReadOnly && !instance.shellLaunchConfig?.customPtyImplementation && instance.state !== 'reconnecting' ? [{
				commandId: TerminalCommandId.Relaunch,
				label: localize('terminal.context.relaunch', 'Relaunch Terminal'),
				run: () => {
					void this.commands.executeCommand(TerminalCommandId.Relaunch, { $mid: MarshalledId.TerminalContext, instanceId: instance.instanceId }).catch(onUnexpectedError);
				},
			}] : undefined,
		});
	}

	protected override disposeCore(): void {
		this.context.instance.statusList?.remove(statusId);
		super.disposeCore();
	}
}

registerTerminalContribution('terminal.environmentChanges', TerminalEnvironmentChangesContribution);

function currentCollection(instance: ITerminalInstance, environment: IEnvironmentVariableService, processes: ITerminalProcessService): IMergedEnvironmentVariableCollection {
	return new MergedEnvironmentVariableCollection(instance.shellLaunchConfig?.strictEnv ? new Map() : environment.collections,
		processes.operatingSystem !== OperatingSystem.Windows);
}

function describeEnvironmentChanges(instance: ITerminalInstance, current: IMergedEnvironmentVariableCollection, scope: EnvironmentVariableScope): string {
	const content = [`# ${localize('terminal.environmentChanges.title', 'Terminal Environment Contributions')}`];
	const snapshot = instance.extEnvironmentVariableCollection;
	content.push(localize('terminal.environmentChanges.launchHeading', '## Contributions selected for this process'));
	if (!snapshot) {
		content.push(localize('terminal.environmentChanges.unknown', 'The launch snapshot is unavailable. The current extension configuration does not describe what was applied to this process.'));
	} else {
		appendCollection(content, snapshot, scope);
		content.push(localize('terminal.environmentChanges.snapshotMeaning', 'This snapshot records the extension mutations selected at launch, not a live reading of process environment values.'));
	}
	content.push(localize('terminal.environmentChanges.futureHeading', '## Current contributions for a new process'));
	appendCollection(content, current, scope);
	if (snapshot) content.push(snapshot.diff(current, scope)
		? localize('terminal.environmentChanges.changed', 'The contributions differ from the launch snapshot. Relaunch the terminal to apply the current configuration.')
		: localize('terminal.environmentChanges.unchanged', 'The contributions match the launch snapshot.'));
	return content.join('\n\n');
}

function appendCollection(content: string[], collection: IMergedEnvironmentVariableCollection, scope: EnvironmentVariableScope): void {
	const descriptions = collection.getDescriptionMap(scope);
	const variables = collection.getVariableMap(scope);
	if (!variables.size) { content.push(localize('terminal.environmentChanges.none', 'No extension environment contributions.')); return; }
	for (const [variable, mutations] of variables) {
		for (const mutation of mutations) {
			content.push(`### ${escapeMarkdownSyntaxTokens(mutation.extensionIdentifier)} — ${escapeMarkdownSyntaxTokens(variable)}`);
			const description = descriptions.get(mutation.extensionIdentifier);
			if (description) content.push(escapeMarkdownSyntaxTokens(description));
			const operation = mutation.type === EnvironmentVariableMutatorType.Append ? '+=' : mutation.type === EnvironmentVariableMutatorType.Prepend ? '=+' : '=';
			content.push(`    ${variable}${operation}${JSON.stringify(mutation.value)}`);
			content.push(mutation.options?.applyAtShellIntegration
				? localize('terminal.environmentChanges.shellPhase', 'Includes a shell startup mutation; this is not a live environment reading.')
				: localize('terminal.environmentChanges.launchPhase', 'Applied at process creation.'));
		}
	}
}

/** Each read-only details editor owns one model and its content provider lifetime. */
class EnvironmentCollectionProvider extends Disposable {
	readonly resource = URI.from({ scheme: `terminal-environment-${generateUuid()}`, path: '/environment.md' });
	constructor(content: string, @ITextModelService textModels: ITextModelService, @IModelService models: IModelService) {
		super();
		let model: ITextModel | undefined;
		this._register(textModels.registerTextModelContentProvider(this.resource.scheme, {
			provideTextContent: async resource => {
				if (resource.toString() !== this.resource.toString()) return null;
				if (!model) {
					model = models.createModel(content, { languageId: 'markdown', onDidChange: Event.None }, resource);
					this._register(model.onWillDispose(() => this.dispose()));
				}
				return model;
			},
		}));
	}
}

registerAction2(class ShowEnvironmentContributionsAction extends Action2 {
	constructor() { super({ id: TerminalCommandId.ShowEnvironmentContributions, title: localize2('terminal.environmentChanges.show', 'Terminal: Show Environment Contributions'), f1: true, precondition: TerminalHasActiveInstanceContext.isEqualTo(true) }); }
	override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
		if (context !== undefined && !URI.isUri(context)) throw new TypeError(localize('terminal.context.invalid', 'Invalid terminal instance context'));
		const terminals = accessor.get(ITerminalService);
		const instance = URI.isUri(context) ? terminals.instances.find(instance => instance.resource?.toString() === context.toString()) : terminals.activeInstance;
		if (context !== undefined && !instance) throw new Error(localize('terminal.context.closed', 'This terminal has been closed'));
		if (!instance) return;
		const scope = { workspaceFolder: accessor.get(IWorkspaceContextService).getWorkspace().folders.find(folder => folder.id === instance.dirId) };
		const content = describeEnvironmentChanges(instance, currentCollection(instance, accessor.get(IEnvironmentVariableService), accessor.get(ITerminalProcessService)), scope);
		const provider = accessor.get(IInstantiationService).createInstance(EnvironmentCollectionProvider, content);
		try {
			using reference = await accessor.get(ITextModelService).createModelReference(provider.resource);
			await accessor.get(IEditorService).openEditor({ resource: provider.resource, readOnly: true, languageId: 'markdown', label: localize('terminal.environmentChanges.title', 'Terminal Environment Contributions') });
		} catch (error) { provider.dispose(); throw error; }
	}
});
