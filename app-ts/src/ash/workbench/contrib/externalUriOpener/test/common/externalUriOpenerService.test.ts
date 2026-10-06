import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { OpenerService } from '../../../../../editor/browser/services/openerService.js';
import { ExternalUriOpenerPriority } from '../../../../../editor/common/languages.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ILogService, type LogEntry } from '../../../../../platform/log/common/log.js';
import { LogService } from '../../../../../platform/log/common/logServiceImpl.js';
import { defaultExternalUriOpenerId, IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../common/contributions.js';
import { builtinLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { IPreferencesService, type IOpenSettingsOptions } from '../../../../services/preferences/common/preferences.js';
import { externalUriOpenersConfigurationNode, externalUriOpenersSettingId } from '../../common/configuration.js';
import { ExternalUriOpenerService, IExternalUriOpenerService, type IExternalUriOpener } from '../../common/externalUriOpenerService.js';
import '../../common/externalUriOpener.contribution.js';

class Picker<T extends IQuickPickItem> extends Disposable implements IQuickPick<T> {
	private readonly accepted = this._register(new Emitter<T>());
	private readonly hidden = this._register(new Emitter<void>());
	public readonly onDidAccept = this.accepted.event;
	public readonly onDidHide = this.hidden.event;
	public readonly onDidChangeValue = Event.None;
	public readonly onDidBlur = Event.None;
	public readonly onDidTriggerItemButton = Event.None;
	public items: readonly T[] = [];
	public ariaLabel = '';
	public placeholder = '';
	public value = '';
	public valueSelection = { start: 0, end: 0 };
	public filterValue = (value: string): string => value;
	public show(): void { }
	public hide(): void { this.hidden.fire(); }
	public accept(index: number): void { this.accepted.fire(this.items[index]!); }
}

type TestPicker = IQuickPick<IQuickPickItem> & { accept(index: number): void; readonly isDisposed: boolean; };

class Fixture extends Disposable {
	public readonly configuration: InMemoryConfigurationService;
	public readonly services: InstantiationService;
	public readonly opener: OpenerService;
	public readonly external: ExternalUriOpenerService;
	public readonly hostOpened: string[] = [];
	public readonly contributedOpened: string[] = [];
	public readonly probed: string[] = [];
	public readonly settings: IOpenSettingsOptions[] = [];
	public readonly logs: LogEntry[] = [];
	private readonly pickerShown = this._register(new Emitter<TestPicker>());
	public picker: TestPicker | undefined;

	constructor() {
		super();
		const registry = new ConfigurationRegistry();
		registry.registerConfiguration(externalUriOpenersConfigurationNode);
		this.configuration = this._register(new InMemoryConfigurationService(registry));
		const descriptor = getSingletonServiceDescriptors().find(([id]) => id === IExternalUriOpenerService)!;
		this.services = this._register(new InstantiationService(new ServiceCollection(descriptor)));
		this.services.registerInstance(IConfigurationService, this.configuration);
		this.services.registerInstance(ICodeEditorService, { getFocusedCodeEditor: () => null, openCodeEditor: async () => null } as unknown as ICodeEditorService);
		this.opener = this._register(this.services.createInstance(OpenerService));
		this.services.registerInstance(IOpenerService, this.opener);
		this.opener.setDefaultExternalOpener({ openExternal: async href => { this.hostOpened.push(href); return true; } });
		this.services.registerInstance(IQuickInputService, {
			createQuickPick: <T extends IQuickPickItem>(): IQuickPick<T> => {
				const picker = new Picker<T>();
				this.picker = picker;
				this.pickerShown.fire(picker);
				return picker;
			},
			input: async () => undefined,
		});
		this.services.registerInstance(IPreferencesService, { openSettings: async () => { }, openGlobalKeybindingSettings: async () => { }, openUserSettings: async options => { this.settings.push(options!); } });
		this.services.registerInstance(ILogService, this._register(new LogService({ sinks: [{ log: entry => this.logs.push(entry) }] })));
		const host = this._register(WorkbenchContributionsRegistry.createHost(this.services, error => { throw error; }, ['workbench.contrib.externalUriOpener']));
		host.advance(WorkbenchPhase.BlockRestore);
		this.external = this.services.get(IExternalUriOpenerService) as ExternalUriOpenerService;
	}

	public waitForPicker(): Promise<TestPicker> {
		if (this.picker) { return Promise.resolve(this.picker); }
		return new Promise(resolve => {
			const listener = this._register(this.pickerShown.event(picker => { listener.dispose(); resolve(picker); }));
		});
	}

	public register(...openers: IExternalUriOpener[]): void {
		this._register(this.external.registerExternalOpenerProvider({ async *getOpeners() { yield* openers; } }));
	}

	public handler(id: string, priority = ExternalUriOpenerPriority.Default): IExternalUriOpener {
		return {
			id, label: id,
			canOpen: async uri => { this.probed.push(`${id}:${uri.toString()}`); return priority; },
			openExternalUri: async uri => { this.contributedOpened.push(`${id}:${uri.toString()}`); return true; },
		};
	}
}

const destination = URI.parse('https://example.test/docs');

suite('External URI opener production routing', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the registered service rejects missing dependencies at creation', () => {
		const descriptor = getSingletonServiceDescriptors().find(([id]) => id === IExternalUriOpenerService)!;
		using services = new InstantiationService(new ServiceCollection(descriptor));
		assert.throws(() => services.get(IExternalUriOpenerService), /openerService/u);
	});

	test('startup installs selection on the real opener; opt-in and default ID control dispatch', async () => {
		using fixture = new Fixture();
		fixture.register(fixture.handler('viewer'));
		await fixture.opener.open(destination);
		await fixture.opener.open(destination, { allowContributedOpeners: defaultExternalUriOpenerId });
		await fixture.opener.open(destination, { allowContributedOpeners: true });
		assert.deepEqual([fixture.hostOpened, fixture.contributedOpened], [[destination.toString(), destination.toString()], [`viewer:${destination.toString()}`]]);
	});

	test('explicit IDs override configuration and bypass capability probes', async () => {
		using fixture = new Fixture();
		fixture.register(fixture.handler('requested', ExternalUriOpenerPriority.None), fixture.handler('configured'));
		await fixture.configuration.updateValue(externalUriOpenersSettingId, { '*': 'configured' });
		await fixture.opener.open(destination, { allowContributedOpeners: 'requested' });
		assert.deepEqual([fixture.probed, fixture.contributedOpened], [[], [`requested:${destination.toString()}`]]);
	});

	test('rules are evaluated in insertion order and unknown IDs do not hide a later available rule', async () => {
		using fixture = new Fixture();
		fixture.register(fixture.handler('viewer', ExternalUriOpenerPriority.None));
		await fixture.configuration.updateValue(externalUriOpenersSettingId, { 'example.test/docs': 'missing', '*.example.test': 'viewer', '*': 'default' });
		await fixture.opener.open(destination, { allowContributedOpeners: true });
		await fixture.configuration.updateValue(externalUriOpenersSettingId, { '*': 'default', 'example.test/docs': 'viewer' });
		await fixture.opener.open(destination, { allowContributedOpeners: true });
		assert.deepEqual([fixture.probed, fixture.contributedOpened, fixture.hostOpened], [[], [`viewer:${destination.toString()}`], [destination.toString()]]);
	});

	test('optional handlers stay discoverable without intercepting ordinary opening', async () => {
		using fixture = new Fixture();
		const option = fixture.handler('option', ExternalUriOpenerPriority.Option);
		fixture.register(fixture.handler('disabled', ExternalUriOpenerPriority.None), option);
		await fixture.opener.open(destination, { allowContributedOpeners: true });
		assert.equal(await fixture.external.getOpener(destination, { sourceUri: destination }, CancellationToken.None), option);
		assert.deepEqual([fixture.contributedOpened, fixture.hostOpened], [[], [destination.toString()]]);
	});

	test('preferred handlers open directly and capability checks use the original URI', async () => {
		using fixture = new Fixture();
		const calls: string[] = [];
		fixture.register({
			id: 'preferred', label: 'Preferred',
			canOpen: async uri => { calls.push(`probe:${uri.toString()}`); return ExternalUriOpenerPriority.Preferred; },
			openExternalUri: async (uri, ctx) => { calls.push(`open:${uri.toString()}:${ctx.sourceUri.toString()}`); return true; },
		}, fixture.handler('other'));
		using resolution = fixture.opener.registerExternalUriResolver({ resolveExternalUri: async () => ({ resolved: URI.parse('https://proxy.test/docs'), ...toDisposable(() => calls.push('released')) }) });
		await fixture.opener.open(destination, { allowContributedOpeners: true });
		assert.deepEqual(calls, [`probe:${destination.toString()}`, `open:https://proxy.test/docs:${destination.toString()}`, 'released']);
		assert.equal(fixture.picker, undefined);
	});

	test('provider enumeration and capability failures are logged without blocking another provider', async () => {
		using fixture = new Fixture();
		using broken = fixture.external.registerExternalOpenerProvider({ async *getOpeners() { throw new Error('enumeration failed'); } });
		fixture.register({ ...fixture.handler('broken'), canOpen: async () => { throw new Error('probe failed'); } }, fixture.handler('viewer'));
		await fixture.opener.open(destination, { allowContributedOpeners: true });
		assert.deepEqual([fixture.logs.map(entry => (entry.error as Error).message), fixture.contributedOpened], [['enumeration failed', 'probe failed'], [`viewer:${destination.toString()}`]]);
	});

	for (const [choice, expected] of [[0, 'first'], [2, 'default'], [3, 'configure'], [undefined, 'cancel']] as const) {
		test(`ambiguous opening handles ${expected} and releases the picker`, async () => {
			using fixture = new Fixture();
			fixture.register(fixture.handler('first'), fixture.handler('second'));
			const result = fixture.opener.open(destination, { allowContributedOpeners: true });
			const picker = await fixture.waitForPicker();
			if (choice === undefined) { picker.hide(); } else { picker.accept(choice); }
			assert.equal(await result, true);
			assert.deepEqual([fixture.contributedOpened, fixture.hostOpened, fixture.settings], [
				choice === 0 ? [`first:${destination.toString()}`] : [],
				choice === 2 ? [destination.toString()] : [],
				choice === 3 ? [{ revealSetting: { key: externalUriOpenersSettingId, edit: true } }] : [],
			]);
			assert.equal(picker.isDisposed, true);
		});
	}

	test('cancellation and service disposal settle an active chooser without executing a handler', async () => {
		using fixture = new Fixture();
		fixture.register(fixture.handler('first'), fixture.handler('second'));
		using token = new CancellationTokenSource();
		const opening = fixture.external.openExternal(destination.toString(), { sourceUri: destination }, token.token);
		await fixture.waitForPicker();
		token.cancel();
		assert.equal(await opening, true);
		fixture.picker = undefined;
		const secondOpening = fixture.external.openExternal(destination.toString(), { sourceUri: destination }, CancellationToken.None);
		await fixture.waitForPicker();
		fixture.external.dispose();
		assert.equal(await secondOpening, true);
		await fixture.opener.open(destination, { allowContributedOpeners: true });
		assert.deepEqual([fixture.contributedOpened, fixture.hostOpened], [[], [destination.toString()]]);
	});

	test('non-web schemes and cancelled discovery never reach a provider', async () => {
		using fixture = new Fixture();
		fixture.register({ async canOpen() { assert.fail('No probe expected'); }, id: 'unused', label: 'Unused', openExternalUri: async () => true });
		assert.equal(await fixture.external.getOpener(destination, { sourceUri: destination }, CancellationToken.Cancelled), undefined);
		assert.equal(await fixture.external.openExternal('mailto:user@example.test', { sourceUri: URI.parse('mailto:user@example.test') }, CancellationToken.None), false);
	});

	test('invalid settings are rejected and the description is translated', async () => {
		using fixture = new Fixture();
		for (const value of [null, [], { '*': 1 }, { '': 'viewer' }, { '*': '' }, { 'https://': 'viewer' }, { 'example.test:bad': 'viewer' }]) {
			await assert.rejects(fixture.configuration.updateValue(externalUriOpenersSettingId, value), TypeError);
		}
		const catalog = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
		setNlsMessages(catalog.locale, catalog.bundles);
		try {
			assert.match(externalUriOpenersConfigurationNode.schema!.description!, /HTTP.*HTTPS.*模式/u);
		} finally { resetNlsResolver(); }
	});
});
