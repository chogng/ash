import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { Emitter } from '../../../base/common/event.js';
import { Disposable, toDisposable } from "../../../base/common/lifecycle.js";
import { URI } from "../../../base/common/uri.js";
import {
	Extensions as ConfigurationExtensions,
	type IConfigurationRegistry,
} from "../../../platform/configuration/common/configurationRegistry.js";
import { ContextKeyService } from "../../../platform/contextkey/browser/contextKeyService.js";
import {
	createServiceIdentifier,
	ServiceContainer,
	ServiceConstructionDescriptor,
} from "../../../platform/instantiation/common/instantiation.js";
import {
	darkColorTheme,
	lightColorTheme,
} from "../../../platform/theme/common/colorTheme.js";
import { Registry } from "../../../platform/registry/common/platform.js";
import {
	WorkbenchState,
} from "../../../platform/workspace/common/workspace.js";
import { WorkspaceContextService } from "../../../workbench/services/workspaces/browser/workspaceContextService.js";
import { BrowserWorkingCopyService } from '../../../workbench/services/workingCopy/browser/browserWorkingCopyService.js';
import {
	getVisibleViewContextKey,
} from "../../../workbench/common/contextkeys.js";
import { createTestWorkbenchContextKeysHandler } from './testWorkbenchContextKeys.js';
import {
	WorkbenchContributionRegistry,
	WorkbenchPhase,
} from "../../../workbench/common/contributions.js";
import { WorkbenchConfiguration } from "../../../workbench/common/configuration.js";

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
import { DialogsModel } from "../../../workbench/common/dialogs.js";
import {
	getWorkbenchColorTheme,
	SystemColorThemePreference,
	WorkbenchThemeRegistry,
} from "../../../workbench/common/theme.js";
import {
	type IView,
	ViewContainerLocation,
	WorkbenchViewContainerId,
	WorkbenchViewRegistry,
} from "../../../workbench/common/views.js";
import {
	DialogResult,
	DialogSeverity,
} from "../../../platform/dialogs/common/dialogs.js";

test("workbench context keys describe the current workspace", () => {
	using contextKeys = new ContextKeyService();
	using workspace = new WorkspaceContextService({
		id: "workspace",
		uri: URI.file("C:\\project"),
	});
	using workingCopies = new BrowserWorkingCopyService();
	const initialChanges: string[][] = [];
	using listener = contextKeys.onDidChangeContext(event => initialChanges.push([...event.keys].sort()));
	using bindings = createTestWorkbenchContextKeysHandler(contextKeys, { workspaceContextService: workspace, workingCopyService: workingCopies });

	assert.deepEqual(initialChanges, [[
		'activeEditorGroupEmpty',
		'activeEditorGroupIndex',
		'activeEditorGroupLast',
		'agentSidebarVisible',
		'auxiliaryBarVisible',
		'dirtyWorkingCopies',
		'editorAreaVisible',
		'editorIsOpen',
		'isLinux',
		'isMac',
		'isNative',
		'isWeb',
		'isWindows',
		'multipleEditorGroups',
		'panelMaximized',
		'panelVisible',
		'sideBarVisible',
		'workbenchState',
		'workspaceFolderCount',
	]]);
	assert.equal(contextKeys.getValue("workbenchState"), "folder");
	assert.equal(contextKeys.getValue("workspaceFolderCount"), 1);
	assert.equal(contextKeys.getValue('dirtyWorkingCopies'), false);
	assert.equal(contextKeys.getValue('isNative'), true);
	assert.equal(contextKeys.getValue('isWeb'), false);
	assert.equal(
		getVisibleViewContextKey("ash.explorer"),
		"view.ash.explorer.visible",
	);
	workspace.updateWorkspace({
		id: 'workspace',
		configuration: URI.file('C:\\project\\ash.code-workspace'),
		folders: [
			{ id: 'first', uri: URI.file('C:\\project'), name: 'project', index: 0 },
			{ id: 'second', uri: URI.file('C:\\library'), name: 'library', index: 1 },
		],
	});
	assert.equal(contextKeys.getValue('workbenchState'), 'workspace');
	assert.equal(contextKeys.getValue('workspaceFolderCount'), 2);

	workspace.updateWorkspace({ id: "empty" });
	assert.equal(contextKeys.getValue("workbenchState"), "empty");
	assert.equal(contextKeys.getValue("workspaceFolderCount"), 0);

	using copy = new TestWorkingCopy(URI.file('C:\\project\\main.ts'));
	using registration = workingCopies.register(copy);
	copy.setDirty(true);
	assert.equal(contextKeys.getValue('dirtyWorkingCopies'), true);
});

test("workbench contributions start once at their declared phases", () => {
	const serviceId = createServiceIdentifier<string>("testService");
	const services = new ServiceContainer();
	services.registerInstance(serviceId, "ready");
	const registry = new WorkbenchContributionRegistry();
	const calls: string[] = [];
	using startupRegistration = registry.register(
		"test.startup",
		WorkbenchPhase.BlockStartup,
		(accessor) => {
			calls.push(`startup:${accessor.get(serviceId)}`);
			return toDisposable(() => calls.push("dispose:startup"));
		},
	);
	using restoredRegistration = registry.register(
		"test.restored",
		WorkbenchPhase.AfterRestored,
		() => {
			calls.push("restored");
			return toDisposable(() => calls.push("dispose:restored"));
		},
	);

	{
		using host = registry.createHost(services);
		host.advance(WorkbenchPhase.BlockStartup);
		host.advance(WorkbenchPhase.BlockRestore);
		host.advance(WorkbenchPhase.AfterRestored);
		host.advance(WorkbenchPhase.AfterRestored);
		assert.deepEqual(calls, ["startup:ready", "restored"]);
	}
	assert.deepEqual(calls, [
		"startup:ready",
		"restored",
		"dispose:restored",
		"dispose:startup",
	]);
});

test("workbench configuration resolves registered color themes", () => {
	assert.equal(
		configurationRegistry.owns(WorkbenchConfiguration.colorTheme),
		true,
	);
	const colorTheme = configurationRegistry.getConfiguration(WorkbenchConfiguration.colorTheme);
	assert.ok(colorTheme);
	assert.equal(
		colorTheme.defaultValue,
		SystemColorThemePreference,
	);
	assert.equal(
		colorTheme.parse(SystemColorThemePreference),
		SystemColorThemePreference,
	);
	assert.equal(
		colorTheme.parse(lightColorTheme.id),
		lightColorTheme.id,
	);
	assert.throws(
		() => colorTheme.parse("missing-theme"),
		/Unknown workbench color theme preference/,
	);
	assert.equal(
		getWorkbenchColorTheme(lightColorTheme.id),
		lightColorTheme,
	);
});

test("workbench configuration exposes modern and flat layout styles", () => {
	assert.equal(configurationRegistry.owns(WorkbenchConfiguration.layoutStyle), true);
	const layoutStyle = configurationRegistry.getConfiguration(WorkbenchConfiguration.layoutStyle);
	assert.ok(layoutStyle);
	assert.equal(layoutStyle.defaultValue, "modern");
	assert.equal(layoutStyle.parse("modern"), "modern");
	assert.equal(layoutStyle.parse("flat"), "flat");
	assert.throws(
		() => layoutStyle.parse("classic"),
		/Unknown Workbench layout style/,
	);
});

test("workbench theme registries reject duplicate themes", () => {
	const registry = new WorkbenchThemeRegistry([darkColorTheme]);
	assert.equal(registry.getColorTheme(darkColorTheme.id), darkColorTheme);
	assert.throws(
		() => registry.registerColorTheme(darkColorTheme),
		/already registered/,
	);
	using registration = registry.registerColorTheme(lightColorTheme);
	assert.deepEqual(
		registry.getColorThemes().map((theme) => theme.id),
		[darkColorTheme.id, lightColorTheme.id],
	);
});

test("dialogs model publishes and settles renderer items", async () => {
	using model = new DialogsModel();
	const events: string[] = [];
	using willShow = model.onWillShowDialog(
		(item) => events.push(`show:${item.request.kind}`),
	);
	using didClose = model.onDidCloseDialog(
		(event) => events.push(
			event.kind === "result"
				? `close:${event.result}`
				: "close:error",
		),
	);
	const handle = model.show({
		kind: "message",
		severity: DialogSeverity.Info,
		message: "Saved",
	});

	assert.equal(model.dialogs.length, 1);
	handle.item.close(DialogResult.Primary);
	assert.equal(await handle.result, DialogResult.Primary);
	assert.equal(model.dialogs.length, 0);
	assert.deepEqual(events, ["show:message", "close:primary"]);
});

test("view registrations are ordered and disposed atomically", () => {
	const registry = new WorkbenchViewRegistry();
	const changes: string[] = [];
	using registered = registry.onDidRegisterViews(
		(event) => changes.push(
			`add:${event.views.map((view) => view.id).join(",")}`,
		),
	);
	using removed = registry.onDidDeregisterViews(
		(event) => changes.push(
			`remove:${event.views.map((view) => view.id).join(",")}`,
		),
	);
	using container = registry.registerViewContainer({
		id: "ash.sidebar",
		title: "Navigation",
		location: ViewContainerLocation.Sidebar,
	});
	using views = registry.registerViews("ash.sidebar", [
		{
			id: "ash.search",
			title: "Search",
			order: 20,
			ctorDescriptor: new ServiceConstructionDescriptor(TestView, {
				staticArguments: ["ash.search"],
			}),
		},
		{
			id: "ash.explorer",
			title: "Explorer",
			order: 10,
			ctorDescriptor: new ServiceConstructionDescriptor(TestView, {
				staticArguments: ["ash.explorer"],
			}),
		},
	]);

	assert.deepEqual(
		registry.getViews("ash.sidebar").map((view) => view.id),
		["ash.explorer", "ash.search"],
	);
	assert.equal(
		registry.getViewContainerForView("ash.explorer")?.id,
		"ash.sidebar",
	);
	assert.throws(
		() => registry.registerViews("ash.sidebar", [
			{
				id: "ash.explorer",
				title: "Duplicate",
				ctorDescriptor: new ServiceConstructionDescriptor(TestView, {
					staticArguments: ["ash.explorer"],
				}),
			},
		]),
		/already registered/,
	);
	assert.deepEqual(
		registry.getViews("ash.sidebar").map((view) => view.id),
		["ash.explorer", "ash.search"],
	);

	views.dispose();
	assert.deepEqual(changes, [
		"add:ash.explorer,ash.search",
		"remove:ash.explorer,ash.search",
	]);
});

test("file views register after their host container", async () => {
	const registry = new WorkbenchViewRegistry();
	registry.registerStaticViewContainer({
		id: WorkbenchViewContainerId.Sidebar,
		title: "Navigation",
		location: ViewContainerLocation.Sidebar,
	});
	const browserEnvironment = new JSDOM("<!doctype html><body></body>");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: browserEnvironment.window,
	});
	try {
		const {
			EXPLORER_VIEW_ID,
			registerFilesViews,
		} = await import(
			"../../../workbench/contrib/files/browser/files.contribution.js"
		);
		const { EmptyView } = await import(
			"../../../workbench/contrib/files/browser/views/emptyView.js"
		);

		registerFilesViews(registry);

		assert.deepEqual(
			registry.getViews(WorkbenchViewContainerId.Sidebar).map(
				(view) => view.id,
			),
			[EXPLORER_VIEW_ID, EmptyView.ID],
		);
		using contextKeys = new ContextKeyService();
		const explorer = registry.getView(EXPLORER_VIEW_ID);
		const empty = registry.getView(EmptyView.ID);
		assert.ok(explorer);
		assert.ok(empty);

		contextKeys.setContext("workspaceFolderCount", 0);
		assert.equal(contextKeys.contextMatchesRules(explorer.when), false);
		assert.equal(contextKeys.contextMatchesRules(empty.when), true);

		contextKeys.setContext("workspaceFolderCount", 1);
		assert.equal(contextKeys.contextMatchesRules(explorer.when), true);
		assert.equal(contextKeys.contextMatchesRules(empty.when), false);
	} finally {
		browserEnvironment.window.close();
		Reflect.deleteProperty(globalThis, "window");
	}
});

class TestView implements IView {
	private visible = true;

	constructor(readonly id: string) {}

	focus(): void {}

	isVisible(): boolean {
		return this.visible;
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
	}
}

class TestWorkingCopy extends Disposable {
	private readonly dirtyEmitter = this._register(new Emitter<void>());
	private readonly contentEmitter = this._register(new Emitter<void>());
	private readonly externalChangeEmitter = this._register(new Emitter<void>());
	readonly onDidChangeDirty = this.dirtyEmitter.event;
	readonly onDidChangeContent = this.contentEmitter.event;
	readonly onDidChangeExternalChange = this.externalChangeEmitter.event;
	readonly backupKind = 'text' as const;
	readonly hasExternalChange = false;
	isDirty = false;

	constructor(readonly resource: URI) {
		super();
	}

	setDirty(isDirty: boolean): void {
		if (this.isDirty === isDirty) return;
		this.isDirty = isDirty;
		this.dirtyEmitter.fire();
	}

	backup(): string { return ''; }
	restoreBackup(): void {}
	async save(): Promise<void> {}
	async saveAs(): Promise<void> {}
	async revert(): Promise<void> {}
}
