import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { DefaultEndOfLine } from '../../common/model.js';
import { ModelService } from '../../common/services/modelService.js';
import { createPieceTreeTextBuffer } from '../../common/model/textBufferFactory.js';
import { EditSources } from '../../common/textModelEditSource.js';
import { InMemoryConfigurationService } from '../../../platform/configuration/common/inMemoryConfigurationService.js';
import type { ITextResourcePropertiesService } from '../../common/services/textResourceConfiguration.js';
import {
	ConfigurationTarget,
	type IConfigurationChangeEvent,
	type IConfigurationData,
	type IConfigurationOverrides,
	type IConfigurationService,
	type IConfigurationUpdateOptions,
	type IConfigurationUpdateOverrides,
	type IConfigurationValue,
} from '../../../platform/configuration/common/configuration.js';
import type { IWorkspaceFolder } from '../../../platform/workspace/common/workspace.js';

test('ModelService owns model creation options and applies indentation detection', () => {
	using configuration = new TestResourceConfigurationService();
	using service = new ModelService(configuration, new TestTextResourcePropertiesService(configuration));
	const resource = URI.parse('inmemory://model-service/indentation.txt');
	const options = service.getCreationOptions('plaintext', resource, true);
	assert.deepEqual(options, {
		tabSize: 4,
		indentSize: 'tabSize',
		insertSpaces: true,
		detectIndentation: true,
		trimAutoWhitespace: true,
		defaultEOL: process.platform === 'win32' ? DefaultEndOfLine.CRLF : DefaultEndOfLine.LF,
		isForSimpleWidget: true,
		largeFileOptimizations: true,
		bracketPairColorizationOptions: { enabled: true, independentColorPoolPerBracketType: false },
	});

	using model = service.createModel('root\n  child\n    grandchild', {
		languageId: 'plaintext',
		onDidChange: Event.None,
	}, resource, true);
	assert.equal(model.getOptions().tabSize, 2);
	assert.equal(model.getOptions().indentSize, 2);
	assert.equal(model.getOptions().insertSpaces, true);
	assert.equal(model.isForSimpleWidget, true);
});

test('ModelService consumes ITextBufferFactory values and releases factory ownership', () => {
	using configuration = new TestResourceConfigurationService();
	using service = new ModelService(configuration, new TestTextResourcePropertiesService(configuration));
	let disposalCount = 0;
	const factory = {
		create: (_defaultEOL: DefaultEndOfLine) => ({
			textBuffer: createPieceTreeTextBuffer('factory value'),
			disposable: { dispose: () => { disposalCount++; }, [Symbol.dispose]: () => { disposalCount++; } },
		}),
		getFirstLineText: (lengthLimit: number) => 'factory value'.slice(0, lengthLimit),
	};
	const resource = URI.parse('inmemory://model-service/factory.txt');
	using model = service.createModel(factory, null, resource);
	assert.equal(model.getValue(), 'factory value');
	assert.equal(disposalCount, 1);

	const source = EditSources.reloadFromDisk();
	service.updateModel(model, {
		...factory,
		create: () => ({
			textBuffer: createPieceTreeTextBuffer('\uFEFFupdated\r\nvalue'),
			disposable: { dispose: () => { disposalCount++; }, [Symbol.dispose]: () => { disposalCount++; } },
		}),
	}, source);
	assert.equal(model.getValue(), 'updated\r\nvalue');
	assert.equal(model.getValue(undefined, true), 'updated\r\nvalue');
	assert.equal(model.getEOL(), '\r\n');
	assert.equal(disposalCount, 2);
	let observedSource: unknown;
	using listener = model.onDidChangeContent(event => { observedSource = event.detailedReasons[0]; });
	service.updateModel(model, 'latest value', source);
	assert.equal(observedSource, source);
	assert.equal(model.canUndo(), true);
	model.undo();
	assert.equal(model.getValue(), 'updated\r\nvalue');
});

test('ModelService restores closed file history only for identical content', () => {
	using configuration = new TestResourceConfigurationService();
	using service = new ModelService(configuration, new TestTextResourcePropertiesService(configuration));
	const resource = URI.file('/workspace/history.txt');
	const first = service.createModel('before', null, resource);
	first.pushEditOperations(null, [{ range: first.getFullModelRange(), text: 'after' }], () => null);
	assert.equal(first.canUndo(), true);
	first.dispose();

	using restored = service.createModel('after', null, resource);
	assert.equal(restored.canUndo(), true);
	restored.undo();
	assert.equal(restored.getValue(), 'before');
	restored.dispose();

	using changed = service.createModel('external change', null, resource);
	assert.equal(changed.canUndo(), false);
});

test('ModelService reapplies model options when platform configuration changes', async () => {
	using configuration = new TestResourceConfigurationService();
	using service = new ModelService(configuration, new TestTextResourcePropertiesService(configuration));
	const model = service.createModel('root\n\tchild', null, URI.parse('inmemory://model-service/configuration.txt'));
	await configuration.updateValue('editor.detectIndentation', false);
	await configuration.updateValue('editor.tabSize', 2);
	await configuration.updateValue('editor.indentSize', 'tabSize');
	await configuration.updateValue('editor.insertSpaces', false);
	assert.equal(model.getOptions().tabSize, 2);
	assert.equal(model.getOptions().indentSize, 2);
	assert.equal(model.getOptions().insertSpaces, false);
});

test('ModelService owns resource identity, language events, and model removal', () => {
	using configuration = new TestResourceConfigurationService();
	using service = new ModelService(configuration, new TestTextResourcePropertiesService(configuration));
	using languageChanges = new Emitter<string>();
	const resource = URI.parse('inmemory://model-service/lifecycle.txt');
	let languageId = 'plaintext';
	const selection = {
		get languageId() { return languageId; },
		onDidChange: languageChanges.event,
	};
	const events: string[] = [];
	using added = service.onModelAdded(model => events.push(`added:${model.uri.toString()}`));
	using changed = service.onModelLanguageChanged(event => events.push(`language:${event.oldLanguageId}->${event.model.getLanguageId()}`));
	using removed = service.onModelRemoved(model => events.push(`removed:${model.uri.toString()}`));

	const model = service.createModel('value', selection, resource);
	assert.strictEqual(service.getModel(resource), model);
	assert.deepEqual(service.getModels(), [model]);
	assert.throws(() => service.createModel('duplicate', null, resource), /already exists/);

	languageId = 'typescript';
	languageChanges.fire(languageId);
	service.destroyModel(resource);

	assert.equal(service.getModel(resource), null);
	assert.deepEqual(service.getModels(), []);
	assert.deepEqual(events, [
		`added:${resource.toString()}`,
		'language:plaintext->typescript',
		`removed:${resource.toString()}`,
	]);
});

class TestTextResourcePropertiesService implements ITextResourcePropertiesService {
	readonly _serviceBrand: undefined;

	constructor(private readonly configuration: IConfigurationService) {}

	getEOL(resource: URI, language?: string): string {
		const eol = this.configuration.getValue<string>('files.eol', { resource, overrideIdentifier: language });
		return eol === 'auto' ? (process.platform === 'win32' ? '\r\n' : '\n') : eol;
	}
}

class TestResourceConfigurationService extends Disposable implements IConfigurationService {
	readonly _serviceBrand = undefined;
	private readonly configuration = this._register(new InMemoryConfigurationService());
	readonly onDidChangeConfiguration: Event<IConfigurationChangeEvent> = (listener, thisArgs, disposables) => (
		this.configuration.onDidChangeConfiguration(
			event => listener.call(thisArgs, resourceIndependentEvent(event)),
			undefined,
			disposables,
		)
	);

	getValue<T>(): T;
	getValue<T>(section: string): T;
	getValue<T>(overrides: IConfigurationOverrides): T;
	getValue<T>(section: string, overrides: IConfigurationOverrides): T;
	getValue<T>(arg1?: string | IConfigurationOverrides, arg2?: IConfigurationOverrides): T {
		if (typeof arg1 === 'string') {
			return arg2 === undefined
				? this.configuration.getValue<T>(arg1)
				: this.configuration.getValue<T>(arg1, withoutResource(arg2));
		}
		return arg1 === undefined
			? this.configuration.getValue<T>()
			: this.configuration.getValue<T>(withoutResource(arg1));
	}

	updateValue(key: string, value: unknown): Promise<void>;
	updateValue(key: string, value: unknown, target: ConfigurationTarget): Promise<void>;
	updateValue(key: string, value: unknown, overrides: IConfigurationOverrides | IConfigurationUpdateOverrides): Promise<void>;
	updateValue(key: string, value: unknown, overrides: IConfigurationOverrides | IConfigurationUpdateOverrides, target: ConfigurationTarget, options?: IConfigurationUpdateOptions): Promise<void>;
	updateValue(key: string, value: unknown, arg3?: ConfigurationTarget | IConfigurationOverrides | IConfigurationUpdateOverrides, target?: ConfigurationTarget, options?: IConfigurationUpdateOptions): Promise<void> {
		if (arg3 === undefined) return this.configuration.updateValue(key, value);
		if (typeof arg3 === 'number') return this.configuration.updateValue(key, value, arg3);
		const overrides = withoutUpdateResource(arg3);
		return target === undefined
			? this.configuration.updateValue(key, value, overrides)
			: this.configuration.updateValue(key, value, overrides, target, options);
	}

	getConfigurationData(): IConfigurationData | null {
		return this.configuration.getConfigurationData();
	}

	inspect<T>(key: string, overrides: IConfigurationOverrides = {}): IConfigurationValue<Readonly<T>> {
		return this.configuration.inspect<T>(key, withoutResource(overrides));
	}

	reloadConfiguration(target?: ConfigurationTarget | IWorkspaceFolder): Promise<void> {
		return this.configuration.reloadConfiguration(target);
	}

	keys(): ReturnType<IConfigurationService['keys']> {
		return this.configuration.keys();
	}
}

function withoutResource(overrides: IConfigurationOverrides): IConfigurationOverrides {
	return { overrideIdentifier: overrides.overrideIdentifier };
}

function withoutUpdateResource(overrides: IConfigurationOverrides | IConfigurationUpdateOverrides): IConfigurationOverrides | IConfigurationUpdateOverrides {
	return 'overrideIdentifiers' in overrides
		? { overrideIdentifiers: overrides.overrideIdentifiers }
		: withoutResource(overrides);
}

function resourceIndependentEvent(event: IConfigurationChangeEvent): IConfigurationChangeEvent {
	return {
		...event,
		affectsConfiguration: (section, overrides) => event.affectsConfiguration(section, overrides ? withoutResource(overrides) : undefined),
	};
}
