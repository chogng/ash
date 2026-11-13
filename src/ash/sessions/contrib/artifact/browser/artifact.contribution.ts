import { buildOpenSessionLinkUri } from '../../../../platform/agentHost/common/openSessionLink.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IGeneratedFilesService } from '../../../services/generatedFiles/common/generatedFilesService.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';
import { OPEN_ARTIFACT_CONVERSATION_COMMAND_ID, OPEN_EXTERNAL_CHAT_CONVERSATION_COMMAND_ID } from '../../chat/common/constants.js';
import { getActiveElement } from '../../../../base/browser/dom.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService, CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { parseArtifactLink } from '../../../../platform/artifactIntegrations/common/artifactLink.js';
import { openArtifactCommands, openLinkedArtifactCommand, type ArtifactWorkspaceId } from '../common/artifactWorkspace.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Menus } from '../../../browser/menus.js';
import { ArtifactEditorView, ArtifactEditorPane } from './artifactEditor.js';
import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import { getArtifactWorkspace } from './artifactWorkspaceRegistry.js';
import { openArtifacts } from './artifactWorkspaceOpener.js';
import { ArtifactPins, IArtifactPins } from './artifactPins.js';
import './artifactCanvasWorkspaces.js';

registerSingleton(IArtifactPins, ArtifactPins, InstantiationType.Eager);

CommandsRegistry.register(openLinkedArtifactCommand, async (accessor, value) => {
	const link = typeof value === 'string' ? parseArtifactLink(URI.parse(value)) : undefined;
	if (!link) throw new Error(localize({ bundle: 'ash.artifacts', key: 'invalidLink' }, 'This artifact link is invalid.'));
	if (link.workspace.id !== accessor.get(IWorkspaceContextService).getWorkspace().id) return false;
	const { type, id } = link.identity;
	if (!await accessor.get(ICommandService).executeCommand<boolean>(openArtifactCommands[type], type === 'table' ? `table:${id}` : id)) {
		throw new Error(localize('sessions.artifacts.linkUnavailable', 'This artifact is unavailable.'));
	}
	return true;
});

CommandsRegistry.register(OPEN_ARTIFACT_CONVERSATION_COMMAND_ID, async (accessor, id) => {
	if (typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id)) throw new TypeError('Invalid generated file identity');
	const opener = accessor.get(IOpenerService);
	const commands = accessor.get(ICommandService);
	const files = accessor.get(IGeneratedFilesService);
	await files.refresh();
	const source = files.files.find(file => file.id === id)?.source;
	if (!source) throw new Error(localize({ bundle: 'ash.artifacts', key: 'generatedFileUnavailable' }, 'This generated file is unavailable.'));
	if (source.providerId === LOCAL_AGENT_HOST_PROVIDER_ID && source.accountId === null) {
		if (await opener.open(buildOpenSessionLinkUri(source.sessionId, source.threadId, 'local'), { fromUserGesture: true })) return;
	} else if (source.accountId && CommandsRegistry.getCommand(OPEN_EXTERNAL_CHAT_CONVERSATION_COMMAND_ID)) {
		if (await commands.executeCommand<boolean>(OPEN_EXTERNAL_CHAT_CONVERSATION_COMMAND_ID, source.providerId, source.accountId, source.sessionId)) return;
	}
	throw new Error(localize('sessions.artifacts.sourceConversationUnavailable', 'The conversation that created this artifact is unavailable.'));
});

registerEditorPane({ id: 'sessions.editor.creator', name: 'Artifacts', canOpen: input => input.resource.scheme === 'ash-creator' && input.resource.path === '/page' ? EditorPaneMatch.Default : EditorPaneMatch.None, create: options => options.instantiationService!.createInstance(ArtifactEditorPane) });

CommandsRegistry.register('sessions.show.creator', (accessor, source) => openArtifacts(accessor, page => page.showHome(), { source: source === 'restore' ? source : undefined }));
CommandsRegistry.register('sessions.restore.creator', (accessor, source) => openArtifacts(accessor, undefined, { source: source === 'restore' ? source : undefined, restoreCommand: 'sessions.restore.creator' }));
CommandsRegistry.register('sessions.creator.openMode', (accessor, value) => {
	if (typeof value !== 'string' || !getArtifactWorkspace(value)) { throw new TypeError(localize('sessions.creator.invalidMode', 'Invalid Artifacts document mode.')); }
	return openArtifacts(accessor, page => page.openMode(value as ArtifactWorkspaceId), { restoreCommand: 'sessions.restore.creator' });
});
registerAction2(class OpenCreator extends Action2 {
	constructor() {
		super({ id: 'sessions.open.creator', title: localize2('sessions.creator.title', 'Artifacts'), icon: Lxicon.artifacts, toggled: ContextKeyExpr.has('sessions.activity.creatorSelected'), menu: { id: Menus.ActivityBar, group: 'navigation', order: 50, when: ContextKeyExpr.notEquals(SessionsWorkspaceModeContext.key, 'code') } });
	}
	public override async run(accessor: ServicesAccessor): Promise<void> { await accessor.get(ICommandService).executeCommand('sessions.show.creator'); }
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.Creator,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') { throw new TypeError(localize('sessions.creator.verbosityInvalid', 'Artifacts accessibility verbosity must be boolean.')); }
		return value;
	},
	setting: { valueType: 'boolean', get title() { return localize('sessions.creator.verbosityTitle', 'Artifacts accessibility help'); }, get description() { return localize('sessions.creator.verbosityDescription', 'Announce how to open accessibility help in Artifacts.'); } },
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type,
		priority: 90,
		name: `sessionsCreator${type}`,
		when: ContextKeyExpr.has('sessionsCreatorFocused'),
		getProvider: accessor => {
			const focused = getActiveElement(accessor.get(ILayoutService).activeContainer.ownerDocument) as HTMLElement;
			const page = ArtifactEditorView.getFocused(focused);
			if (!page) { return undefined; }
			return new AccessibleContentProvider(AccessibleViewProviderId.Creator, { type }, () => type === AccessibleViewType.Help ? `${localize('sessions.creator.help', 'Artifacts\nUse Tab and Shift+Tab to reach filters, search, view options, creation cards and your existing work. Press Enter on a creation card to open a new chat with that artifact type shown below the input. When the title is a button, press Enter to open the available artifact actions. Use Up and Down to move through the menu and Escape to return to the title. If Rename is available, choose it or double-click the title to edit it in place. Press Enter to save or Escape to cancel. In the window title bar, use Left and Right to reach Export, Maximize artifact, Restore artifact size, or Close artifact. Close artifact returns to the conversation. Show Secondary Side Bar opens canvas properties when available. Press Enter on a generated artifact to return to the conversation that created it. Open its file from that conversation. Other saved work opens in its editor. Use Left and Right to move between All, Yours and Shared with you. Press Enter or Space to apply the focused filter. Search filters titles; sort changes title order. Layout grid switches your work between grid and list views. The Artifacts navigation item returns home and retains each workspace. In the Command Palette, Choose Docs editor sets the editor preference and can open a blank document. Docs uses rich document or Markdown format according to the Docs editor preference. Design saves automatically. Use Save document for files opened in the Slides workspace. Preview supports Left and Right to change slides and Escape to return.')}\n\n${page.getWorkspaceAccessibilityHelp() ?? ''}${page.getAccessibleContent()}` : page.getAccessibleContent(), () => focused.focus(), AccessibilityVerbositySettingId.Creator);
		},
	});
}
