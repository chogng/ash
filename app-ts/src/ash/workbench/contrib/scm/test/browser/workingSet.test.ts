import '../../../../../editor/test/browser/testEditorDom.js';
import '../../browser/scm.contribution.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { StorageScope, type IStorageService } from '../../../../../platform/storage/common/storage.js';
import type { IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import type { EditorWorkingSet, EditorWorkingSetTarget } from '../../../../services/editor/common/editorWorkingSet.js';
import type { ISCMProvider } from '../../common/scm.js';
import { SCMService } from '../../common/scmService.js';
import { SCMViewService } from '../../browser/scmViewService.js';
import { ScmWorkingSetController } from '../../browser/workingSet.js';

test('SCM working sets save and restore editor state across branch changes', async () => {
	using configuration = new InMemoryConfigurationService();
	await configuration.updateValue('scm.workingSets.enabled', true);
	await configuration.updateValue('scm.workingSets.default', 'empty');
	using provider = new TestSCMProvider('main');
	using scmService = new SCMService();
	using viewService = new SCMViewService(scmService);
	using repository = scmService.registerSCMProvider(provider);
	const storage = new TestStorageService();
	const saved: string[] = [];
	const applied: EditorWorkingSetTarget[] = [];
	const editorPart = {
		domNode: globalThis.document?.body ?? ({ ownerDocument: { activeElement: undefined }, contains: () => false } as unknown as HTMLElement),
		saveWorkingSet(id: string): EditorWorkingSet {
			saved.push(id);
			return workingSet(id);
		},
		async applyWorkingSet(target: EditorWorkingSetTarget): Promise<void> {
			applied.push(target);
		},
	} as unknown as IEditorPart;
	using controller = new ScmWorkingSetController({
		configurationService: configuration,
		editorPart,
		scmViewService: viewService,
		storageService: storage as unknown as IStorageService,
	});
	await nextTask();

	provider.accept('feature');
	await nextTask();
	assert.deepEqual(saved, ['main']);
	assert.deepEqual(applied, ['empty']);
	assert.ok(storage.get('scm.workingSets', StorageScope.WORKSPACE)?.includes('main'));

	provider.accept('main');
	await nextTask();
	assert.deepEqual(saved, ['main', 'feature']);
	assert.deepEqual(applied, ['empty', workingSet('main')]);

	await configuration.updateValue('scm.workingSets.enabled', false);
	assert.equal(storage.get('scm.workingSets', StorageScope.WORKSPACE), undefined);
	provider.accept('other');
	await nextTask();
	assert.deepEqual(saved, ['main', 'feature']);
});

function workingSet(id: string): EditorWorkingSet {
	return {
		id,
		activeGroupIndex: 0,
		groups: [{ activeEditorIndex: -1, editors: [], size: 1 }],
	};
}

class TestSCMProvider implements ISCMProvider {
	readonly id = 'repo-1';
	readonly providerId = 'test';
	readonly label = 'project';
	readonly groups = [];
	readonly input = { value: '', placeholder: '', enabled: false, canAccept: false, buttonLabel: '', buttonTooltip: '', accept: async () => undefined };
	readonly statusBarCommands = [];
	readonly statusMessage = '';
	readonly isBusy = false;
	private readonly changed = new Emitter<void>();
	readonly onDidChangeResources = this.changed.event;

	constructor(public activeRepositoryName: string) {}
	accept(ref: string): void { this.activeRepositoryName = ref; this.changed.fire(); }
	refresh(): Promise<void> { return Promise.resolve(); }
	activate(): Promise<void> { return Promise.resolve(); }
	dispose(): void { this.changed.dispose(); }
	[Symbol.dispose](): void { this.dispose(); }
}

class TestStorageService {
	private readonly values = new Map<string, string>();

	get(key: string, _scope: StorageScope): string | undefined {
		return this.values.get(key);
	}

	store(key: string, value: string): void {
		this.values.set(key, value);
	}

	remove(key: string): void {
		this.values.delete(key);
	}
}

function nextTask(): Promise<void> {
	return new Promise(resolve => globalThis.setTimeout(resolve, 0));
}
