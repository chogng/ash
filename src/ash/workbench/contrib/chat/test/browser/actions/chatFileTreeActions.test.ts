import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import '../../../browser/chat.shared.contribution.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IChatWidgetService, type IChatWidget, type IChatFileTreeInfo } from '../../../browser/chat.js';
import type { IChatListItem } from '../../../common/model/chatViewModel.js';

const artifact = { type: 'artifact', artifact: { source: { type: 'structuredResult' }, mimeType: 'application/json', contentDigest: 'fixture', truncated: false, data: { type: 'json', json: JSON.stringify({ kind: 'treeData', treeData: { label: 'Workspace', uri: 'file:///workspace', children: [{ label: 'main.ts', uri: 'file:///workspace/main.ts' }] } }) } } } as const;
const first = { id: 'first', type: 'toolCall', text: '', transient: false, content: [artifact] } as IChatListItem;
const latest = { ...first, id: 'latest' };

class Fixture extends Disposable {
	readonly services = this._register(new InstantiationService());
	readonly focused: number[] = [];
	readonly revealed: string[] = [];
	current: IChatFileTreeInfo | undefined;
	item: IChatListItem | undefined;
	disabled = false;
	visible = true;
	readonly trees = Array.from({ length: 2 }, (_, treeIndex): IChatFileTreeInfo => ({ treeIndex, treeDataId: String(treeIndex), focus: () => { this.focused.push(treeIndex); this.current = this.trees[treeIndex]; } }));
	constructor() {
		super();
		const fixture = this;
		const widget = { get visible() { return fixture.visible; }, model: { items: [first, latest] }, getFocus: () => this.item, reveal: (item: IChatListItem) => this.revealed.push(item.id), getFileTreeInfosForResponse: () => this.trees, getLastFocusedFileTreeForResponse: () => this.current } as unknown as IChatWidget;
		this.services.registerInstance(IChatWidgetService, { lastFocusedWidget: widget } as IChatWidgetService);
		this.services.registerInstance(IConfigurationService, { getValue: () => this.disabled } as unknown as IConfigurationService);
	}
	async run(reverse = false) { await this.services.invokeFunction(CommandsRegistry.getCommand(reverse ? 'workbench.action.chat.previousFileTree' : 'workbench.action.chat.nextFileTree')!); }
}

suite('File tree actions through the shared registration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('uses the newest result and cycles in both directions', async () => {
		using f = new Fixture(); await f.run(); await f.run(); await f.run(); await f.run(true);
		assert.deepEqual(f.focused, [0, 1, 0, 1]); assert.deepEqual(f.revealed, ['latest', 'latest', 'latest', 'latest']);
	});
	test('starts reverse navigation at the last tree in the focused result', async () => {
		using f = new Fixture(); f.item = first; await f.run(true);
		assert.deepEqual(f.focused, [1]); assert.deepEqual(f.revealed, ['first']);
	});
	test('hidden chats and AI disablement do not reveal or focus resources', async () => {
		using f = new Fixture(); f.visible = false; await f.run(); f.visible = true; f.disabled = true; await f.run();
		assert.deepEqual(f.focused, []); assert.deepEqual(f.revealed, []);
	});
});
