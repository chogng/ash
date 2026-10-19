import { browserEnvironment } from '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { toDisposable } from '../../../../../../base/common/lifecycle.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { TriggerAction, type IPickerQuickAccessItem } from '../../../../../../platform/quickinput/browser/pickerQuickAccess.js';
import { QuickAccessRegistry } from '../../../../../../platform/quickinput/common/quickAccess.js';
import { IQuickInputService, QuickInputType, type IQuickPick, type IQuickPickItem } from '../../../../../../platform/quickinput/common/quickInput.js';
import { TestQuickInputService } from '../../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { TerminalLocation } from '../../../../../../platform/terminal/common/terminal.js';
import { CommandService } from '../../../../../services/commands/common/commandService.js';
import { ITerminalEditingService, ITerminalEditorService, ITerminalGroupService, ITerminalService, type ITerminalInstance } from '../../../../terminal/browser/terminal.js';
import { TerminalQuickAccessProvider } from '../../browser/terminalQuickAccess.js';
import '../../browser/terminal.quickAccess.contribution.js';

suite('Terminal Quick Access', () => {
	test('command opens the registered terminal provider', async () => {
		using services = new InstantiationService();
		const shown: string[] = [];
		services.registerInstance(IQuickInputService, { quickAccess: { show: (value: string) => shown.push(value) } } as unknown as IQuickInputService);
		using commands = new CommandService(services, CommandsRegistry);
		await commands.executeCommand('workbench.action.quickOpenTerm');
		assert.deepEqual(shown, ['term ']);
		assert.equal(QuickAccessRegistry.get('term bash')?.ctor, TerminalQuickAccessProvider);
	});

	test('terminal navigation commands apply only to the terminal picker', async () => {
		using services = new InstantiationService();
		const directions: boolean[] = [];
		const picker = { type: QuickInputType.QuickPick, value: '>other picker' };
		services.registerInstance(IQuickInputService, {
			currentQuickInput: picker, navigate: (next: boolean) => directions.push(next),
		} as unknown as IQuickInputService);
		using commands = new CommandService(services, CommandsRegistry);
		await commands.executeCommand('workbench.action.quickOpenNavigateNextInTerminalPicker');
		assert.deepEqual(directions, []);
		picker.value = 'term shell';
		await commands.executeCommand('workbench.action.quickOpenNavigateNextInTerminalPicker');
		await commands.executeCommand('workbench.action.quickOpenNavigatePreviousInTerminalPicker');
		assert.deepEqual(directions, [true, false]);
	});

	test('filters live instances and routes acceptance, rename and confirmed close to their owners', async () => {
		using services = new InstantiationService();
		using changed = new Emitter<void>();
		const panel = { title: 'Build shell', target: TerminalLocation.Panel } as ITerminalInstance;
		const editor = { title: 'Remote editor', target: TerminalLocation.Editor } as ITerminalInstance;
		const instances = [panel, editor];
		let active: ITerminalInstance | undefined = panel;
		const effects: unknown[] = [];
		services.registerInstance(ITerminalService, {
			get instances() { return instances; }, get activeInstance() { return active; },
			onDidChangeInstances: changed.event, onDidChangeActiveInstance: Event.None,
			setActiveInstance(instance: ITerminalInstance) { active = instance; effects.push(instance); },
			async safeDisposeTerminal(instance: ITerminalInstance) { effects.push(['close', instance]); },
		} as unknown as ITerminalService);
		services.registerInstance(ITerminalGroupService, { async showPanel(focus: boolean) { effects.push(['panel', focus]); } } as ITerminalGroupService);
		services.registerInstance(ITerminalEditorService, { async openEditor(instance: ITerminalInstance) { effects.push(['editor', instance]); } } as ITerminalEditorService);
		services.registerInstance(ITerminalEditingService, { async rename(instance: ITerminalInstance) { effects.push(['rename', instance]); } } as ITerminalEditingService);
		using provider = services.createInstance(TerminalQuickAccessProvider);
		using typed = new Emitter<string>();
		const picker = {
			value: 'term ', items: [] as IQuickPickItem[], selectedItems: [],
			onDidChangeValue: typed.event, onDidAccept: Event.None, onDidTriggerItemButton: Event.None,
		} as unknown as IQuickPick<IPickerQuickAccessItem>;
		using showing = provider.provide(picker, CancellationToken.None);
		const items = (): IPickerQuickAccessItem[] => picker.items.filter((item): item is IPickerQuickAccessItem => !('type' in item));
		assert.deepEqual(items().map(item => [item.label, item.description, item.picked]), [
			['Build shell', 'Panel', true], ['Remote editor', 'Editor', false],
		]);
		const oldPanel = items()[0]!;
		const oldEditor = items()[1]!;
		oldEditor.accept!({ ctrlCmd: false, alt: false, shift: false }, { inBackground: false });
		assert.deepEqual(effects, [editor, ['editor', editor]]);
		effects.length = 0;
		oldPanel.accept!({ ctrlCmd: false, alt: false, shift: false }, { inBackground: false });
		assert.deepEqual(effects, [panel, ['panel', true]]);
		effects.length = 0;
		assert.equal(await oldEditor.trigger!(0, { ctrlCmd: false, alt: false, shift: false }), TriggerAction.REFRESH_PICKER);
		assert.equal(await oldEditor.trigger!(1, { ctrlCmd: false, alt: false, shift: false }), TriggerAction.REFRESH_PICKER);
		assert.deepEqual(effects, [['rename', editor], ['close', editor]]);
		picker.value = 'term rmed';
		typed.fire(picker.value);
		assert.deepEqual(items().map(item => item.label), ['Remote editor']);
		instances.splice(1, 1);
		changed.fire();
		assert.deepEqual(items().map(item => item.label), ['No matching terminals']);
		effects.length = 0;
		oldEditor.accept!({ ctrlCmd: false, alt: false, shift: false }, { inBackground: false });
		await oldEditor.trigger!(1, { ctrlCmd: false, alt: false, shift: false });
		assert.deepEqual(effects, []);
	});

	test('production construction requires the existing terminal owners', () => {
		using services = new InstantiationService();
		assert.throws(() => services.createInstance(TerminalQuickAccessProvider), /terminalService/);
	});

	test('the production picker keeps the browsed terminal when an earlier row disappears and its title changes', async () => {
		using services = new InstantiationService();
		using changed = new Emitter<void>();
		const first = { title: 'First shell', target: TerminalLocation.Panel };
		const browsed = { title: 'Browsed shell', target: TerminalLocation.Panel };
		const last = { title: 'Last shell', target: TerminalLocation.Panel };
		const instances = [first, browsed, last] as ITerminalInstance[];
		let active = instances[0];
		const revealed: ITerminalInstance[] = [];
		services.registerInstance(ITerminalService, {
			get instances() { return instances; }, get activeInstance() { return active; },
			onDidChangeInstances: changed.event, onDidChangeActiveInstance: Event.None,
			setActiveInstance(instance: ITerminalInstance) { active = instance; revealed.push(instance); },
		} as unknown as ITerminalService);
		services.registerInstance(ITerminalGroupService, { async showPanel() { } } as ITerminalGroupService);
		services.registerInstance(ITerminalEditorService, {
			async openEditor() { throw new Error('This scenario reveals panel terminals'); },
			async splitInstance() { throw new Error('Quick Access does not split terminals'); },
			async detachInstance() { throw new Error('Quick Access does not move terminals'); },
			getInstanceFromResource() { throw new Error('Quick Access uses instance identity'); },
		});
		services.registerInstance(ITerminalEditingService, {
			async rename() { throw new Error('This scenario renames through the instance owner'); },
			getEditingTerminal() { return undefined; },
		});
		const container = browserEnvironment.window.document.createElement('div');
		browserEnvironment.window.document.body.append(container);
		using removeContainer = toDisposable(() => container.remove());
		using quickInput = new TestQuickInputService({ container, instantiationService: services });
		services.registerInstance(IQuickInputService, quickInput);
		using commands = new CommandService(services, CommandsRegistry);
		await commands.executeCommand('workbench.action.quickOpenTerm');
		const picker = quickInput.currentQuickInput as IQuickPick<IPickerQuickAccessItem>;
		quickInput.navigate(true);
		const browsedPick = picker.activeItems[0]!;
		assert.equal(browsedPick.label, 'Browsed shell');
		instances.shift();
		changed.fire();
		assert.deepEqual(picker.items.map(item => item.label), ['Browsed shell', 'Last shell']);
		assert.equal(picker.activeItems[0], browsedPick);
		browsed.title = 'Renamed browsed shell';
		changed.fire();
		assert.equal(picker.activeItems[0], browsedPick);
		assert.equal(picker.activeItems[0]!.label, 'Renamed browsed shell');
		await quickInput.accept();
		assert.deepEqual(revealed, [browsed]);
		assert.equal(active, browsed);
		assert.equal(quickInput.currentQuickInput, undefined);
	});
});
