import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { autorun, observableValue } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { MenusRegistry } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { createServiceIdentifier, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ActivityBarItemContext } from '../../../common/contextkeys.js';
import { Menus } from '../../../browser/menus.js';
import { parseArtifactKey, type ArtifactIdentity } from '../../../../platform/artifactIntegrations/common/artifactLink.js';
import { openArtifactCommands } from '../common/artifactWorkspace.js';
import { createArtifactCatalogSources, type ArtifactCatalogSource } from './artifactWorkspaceRegistry.js';

export interface IArtifactPins {
	has(identity: ArtifactIdentity): boolean;
	setPinned(identity: ArtifactIdentity, pinned: boolean): void;
}

export const IArtifactPins = createServiceIdentifier<IArtifactPins>('artifactPins');

const storageKey = 'sessions.artifacts.pinned';

/** Stores sidebar shortcuts by identity. Titles and open targets come from the live catalog. */
export class ArtifactPins extends Disposable implements IArtifactPins {
	private readonly keys = observableValue<ReadonlySet<string>>(this, new Set());

	constructor(
		@IStorageService private readonly storage: IStorageService,
		@IAccessibilityService private readonly accessibility: IAccessibilityService,
		@IInstantiationService instantiation: IInstantiationService,
		@ICommandService commands: ICommandService,
	) {
		super();
		this.readPins();
		this._register(storage.onDidChangeValue(event => {
			if (event.scope === StorageScope.WORKSPACE && event.key === storageKey) this.readPins();
		}));
		let sources: readonly ArtifactCatalogSource[] | undefined;
		const items = this._register(new DisposableStore());
		this._register(autorun(reader => {
			const keys = this.keys.read(reader);
			items.clear();
			if (!keys.size) return;
			sources ??= createArtifactCatalogSources(instantiation);
			const cards = sources.flatMap(source => source.cards.read(reader));
			for (const card of cards) {
				const key = card.workspaceKey;
				if (!key || !keys.has(key)) continue;
				const identity = parseArtifactKey(key);
				if (!identity) continue;
				const id = `sessions.artifacts.pinned.${identity.type}.${identity.id}`;
				items.add(CommandsRegistry.register(id, () => commands.executeCommand(
					openArtifactCommands[identity.type], identity.type === 'table' ? key : identity.id,
				)));
				items.add(MenusRegistry.appendMenuItem(Menus.ActivityBar, {
					command: { id, title: card.title, icon: Lxicon.artifacts }, group: 'navigation', order: 51,
				}));
				const unpin = `${id}.unpin`;
				items.add(CommandsRegistry.register(unpin, () => this.setPinned(identity, false)));
				items.add(MenusRegistry.appendMenuItem(Menus.ActivityBarContext, {
					command: { id: unpin, title: localize('sessions.artifacts.unpin', 'Unpin from sidebar'), icon: Lxicon.unpin },
					group: 'artifact', when: ActivityBarItemContext.isEqualTo(id),
				}));
			}
		}));
	}

	has(identity: ArtifactIdentity): boolean {
		return this.keys.get().has(`${identity.type}:${identity.id}`);
	}

	setPinned(identity: ArtifactIdentity, pinned: boolean): void {
		const key = `${identity.type}:${identity.id}`;
		const keys = new Set(this.keys.get());
		if (keys.has(key) === pinned) return;
		if (pinned) keys.add(key);
		else keys.delete(key);
		this.keys.set(keys, undefined);
		this.storage.store(storageKey, JSON.stringify([...keys]), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.accessibility.status(pinned ? localize('sessions.artifacts.pinned', 'Artifact pinned to the sidebar.')
			: localize('sessions.artifacts.unpinned', 'Artifact unpinned from the sidebar.'));
	}

	private readPins(): void {
		const raw = this.storage.get(storageKey, StorageScope.WORKSPACE);
		let value: unknown;
		try { value = raw === undefined ? [] : JSON.parse(raw); }
		catch { value = []; }
		const keys = Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string' && !!parseArtifactKey(key)) : [];
		this.keys.set(new Set(keys), undefined);
	}
}
