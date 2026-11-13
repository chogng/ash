import { isUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { getArtifactTitle } from '../../artifact/browser/artifactKindPresentation.js';
import { openArtifactWorkspace } from '../../artifact/browser/artifactWorkspaceOpener.js';
import { registerArtifactCatalogSource } from '../../artifact/browser/artifactWorkspaceRegistry.js';
import { openArtifactCommands } from '../../artifact/common/artifactWorkspace.js';
import { ArtifactTableWorkspace, type TableArtifactExample } from './artifactTableWorkspace.js';
import { ArtifactTableDraft, IArtifactTableDrafts, type TableArtifactKind } from './artifactTableDrafts.js';

const openTableCommand = openArtifactCommands.table;

export function registerTableArtifactCatalog(kind: TableArtifactKind): void {
	registerArtifactCatalogSource(accessor => {
		const tables = accessor.get(IArtifactTableDrafts);
		return {
			cards: tables.drafts.map((drafts, reader) => [...drafts.values()].filter(draft => draft.kind === kind).map(draft => {
				const key = `table:${draft.id}`;
				return {
					kind, title: draft.title.read(reader) ?? getTableTitle(kind), detail: getArtifactTitle(kind), workspaceKey: key,
					command: { id: openTableCommand, args: [key] },
				};
			})),
			isRestoring: tables.isRestoring,
		};
	});
}

export function openTableArtifact(accessor: ServicesAccessor, source: TableArtifactExample | ArtifactTableDraft): Promise<void> {
	const { kind } = source;
	const title = source instanceof ArtifactTableDraft ? getTableTitle(kind) : source.title;
	return openArtifactWorkspace(accessor, {
		key: source instanceof ArtifactTableDraft ? `table:${source.id}` : `example:${kind}`, entryId: kind, title,
		mount: (instantiation, container) => {
			const workspace = instantiation.createInstance(ArtifactTableWorkspace, container.ownerDocument, title, source);
			workspace.create(container);
			return workspace;
		},
	});
}

CommandsRegistry.register(openTableCommand, async (accessor, key) => {
	if (typeof key !== 'string' || !key.startsWith('table:') || !isUuid(key.slice('table:'.length))) return false;
	const tables = accessor.get(IArtifactTableDrafts);
	const instantiation = accessor.get(IInstantiationService);
	await tables.ready;
	const draft = tables.drafts.get().get(key.slice('table:'.length));
	if (!draft) return false;
	await instantiation.invokeFunction(accessor => openTableArtifact(accessor, draft));
	return true;
});

function getTableTitle(kind: TableArtifactKind): string {
	return localize('sessions.creator.untitled', 'Untitled {0}', getArtifactTitle(kind));
}
