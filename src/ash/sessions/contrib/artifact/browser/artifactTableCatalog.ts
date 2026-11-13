import { readArtifactState } from './artifactStorage.js';
import { isUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { getArtifactTitle } from './artifactKindPresentation.js';
import { ISessionsEntryService } from '../../../services/layout/common/sessionsEntryService.js';
import { URI } from '../../../../base/common/uri.js';
import { extUri } from '../../../../base/common/resources.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { registerArtifactCatalogSource } from './artifactWorkspaceRegistry.js';
import { artifactDetailEntry, openArtifactCommands } from '../common/artifactWorkspace.js';
import { ArtifactTableEditor } from './artifactTableEditor.js';
import { IArtifactTableService } from '../common/artifactTableService.js';
import type { ArtifactTableModel, ArtifactTableKind } from '../common/artifactTableModel.js';

const openTableCommand = openArtifactCommands.table;

export function registerArtifactTableCatalog(kind: ArtifactTableKind): void {
	registerArtifactCatalogSource(accessor => {
		const tables = accessor.get(IArtifactTableService);
		return {
			cards: tables.drafts.map((drafts, reader) => [...drafts.values()].filter(draft => draft.kind === kind).map(draft => {
				const resource = tables.resource(draft);
				return {
					kind, title: draft.title.read(reader) ?? getTableTitle(kind), detail: getArtifactTitle(kind), owner: 'you' as const, resource, createdAt: draft.createdAt,
					command: { id: openTableCommand, args: [resource.toString()] },
				};
			})),
			isRestoring: tables.isRestoring,
		};
	});
}

const activeTableKey = 'sessions.artifacts.activeTable';

function openTableArtifact(accessor: ServicesAccessor, source: ArtifactTableModel, origin?: 'restore'): Promise<void> {
	const resource = accessor.get(IArtifactTableService).resource(source);
	const storage = accessor.get(IStorageService);
	const entry = {
		...artifactDetailEntry, id: 'artifacts.table', restoreCommand: 'sessions.restore.artifactsTable',
		editorInput: { resource, editorId: ArtifactTableEditor.ID, label: source.title.get() ?? getTableTitle(source.kind), showBreadcrumbs: false },
	};
	return accessor.get(ISessionsEntryService).openEntry(entry, () => {
		storage.store(activeTableKey, resource.toString(), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		return entry;
	}, { source: origin });
}

CommandsRegistry.register(openTableCommand, async (accessor, value) => {
	if (typeof value !== 'string') return false;
	const tables = accessor.get(IArtifactTableService);
	await tables.ready;
	// Artifact links use stable document IDs; catalog cards open the persisted resource.
	let draft: ArtifactTableModel | undefined;
	if (value.startsWith('table:') && isUuid(value.slice('table:'.length))) {
		draft = tables.drafts.get().get(value.slice('table:'.length));
	} else {
		let resource: URI;
		try { resource = URI.parse(value); } catch { return false; }
		draft = [...tables.drafts.get().values()].find(item => extUri.isEqual(tables.resource(item), resource));
	}
	if (!draft) return false;
	await openTableArtifact(accessor, draft);
	return true;
});

CommandsRegistry.register('sessions.restore.artifactsTable', async accessor => {
	const stored = readArtifactState(accessor.get(IStorageService), activeTableKey);
	if (!stored) return;
	let resource: URI;
	try { resource = URI.parse(stored); } catch { return; }
	const tables = accessor.get(IArtifactTableService);
	await tables.ready;
	const draft = [...tables.drafts.get().values()].find(item => extUri.isEqual(tables.resource(item), resource));
	if (draft) await openTableArtifact(accessor, draft, 'restore');
});

function getTableTitle(kind: ArtifactTableKind): string {
	return localize('sessions.artifacts.untitled', 'Untitled {0}', getArtifactTitle(kind));
}
