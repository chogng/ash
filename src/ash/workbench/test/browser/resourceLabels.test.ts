import { createTestEditorServices } from '../common/testEditorServices.js';
import { IUntitledTextEditorService } from '../../services/untitled/common/untitledTextEditorService.js';
import { Lxicon } from '../../../base/common/lxicons.js';
import { noFileIconTheme } from '../../../platform/theme/common/themeService.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter } from '../../../base/common/event.js';
import { URI } from '../../../base/common/uri.js';
import { FileKind } from '../../../platform/files/common/files.js';
import { NullLoggerService } from '../../../platform/log/common/log.js';
import type { IDecorationData } from '../../services/decorations/common/decorations.js';
import { OperatingSystem } from '../../../base/common/platform.js';
import { LabelService } from '../../../platform/label/common/labelService.js';
import { WorkspaceContextService } from '../../services/workspaces/browser/workspaceContextService.js';
import { DecorationsService } from '../../services/decorations/browser/decorationsService.js';
import { DEFAULT_LABELS_CONTAINER, IResourceLabelService, ResourceLabels, type IResourceIconRenderer } from '../../browser/labels.js';

test('ResourceLabels formats files and reacts to icon and decoration changes', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const root = URI.file('C:/project');
	const resource = URI.file('C:/project/src/main.ts');
	using workspace = new WorkspaceContextService({ id: 'workspace', uri: root });
	using decorations = new DecorationsService(dom.window.document, new NullLoggerService());
	using decorationUpdates = new Emitter<readonly URI[]>();
	let decorationData: IDecorationData | undefined;
	using provider = decorations.registerDecorationsProvider({ label: 'Test', onDidChange: decorationUpdates.event, provideDecorations: () => decorationData });
	using labelService = new LabelService(workspace, OperatingSystem.Linux);
	using iconThemeChange = new Emitter<void>();
	const resourceIconRenderer: IResourceIconRenderer = {
		onDidChangeResourceIcons: iconThemeChange.event,
		getFileIconTheme: () => ({ ...noFileIconTheme, hasFileIcons: true }),
		renderFileIcon: (_resource, container) => {
			container.classList.add('test-file-icon');
			container.textContent = 'T';
		},
	};
	using labels = new ResourceLabels(DEFAULT_LABELS_CONTAINER, {
		workspaceContextService: workspace,
		resourceIconRenderer,
		decorationsService: decorations,
		labelService,
	});
	const label = labels.create(dom.window.document.body);
	let decorationChanges = 0;
	using decorationListener = labels.onDidChangeDecorations(() => decorationChanges += 1);
	label.setFile(resource, {
		fileKind: FileKind.File,
		fileDecorations: { colors: true, badges: true },
	});

	assert.equal(label.element.querySelector('.ash-icon-label-text')?.textContent, 'main.ts');
	assert.equal(label.element.querySelector('.ash-icon-label-description')?.textContent, 'src');
	assert.equal(label.element.querySelector('.test-file-icon')?.textContent, 'T');

	decorationData = { color: 'description.foreground', tooltip: 'Ignored', strikethrough: true };
	decorationUpdates.fire([resource]);
	assert.match(label.element.className, /ash-decoration-\d+-color/u);
	assert.equal(label.element.classList.contains('strikethrough'), true);
	assert.equal(decorationChanges, 1);
	assert.equal(label.element.getAttribute('aria-label'), 'main.ts, Ignored');

	decorationData = { letter: Lxicon.add, tooltip: 'Added' };
	decorationUpdates.fire([resource]);
	assert.equal(label.element.querySelector('.ash-icon-label-suffix-icon svg')?.getAttribute('data-ash-icon-id'), 'add');
	label.setFile(resource, { fileDecorations: { colors: true, badges: false } });
	assert.equal(label.element.querySelector('.ash-icon-label-suffix-icon svg'), null);
	assert.equal(label.element.getAttribute('aria-label'), 'main.ts, Added');


	using formatter = labelService.registerFormatter({
		scheme: 'file',
		format: candidate => `formatted:${candidate.path}`,
	});
	assert.equal(label.element.querySelector('.ash-icon-label-description')?.textContent, 'formatted:/C:/project/src/');
	formatter.dispose();
	assert.equal(label.element.querySelector('.ash-icon-label-description')?.textContent, 'src');

	iconThemeChange.fire();
	assert.equal(label.element.querySelector('.test-file-icon')?.textContent, 'T');

	dom.window.close();
});

test('Workspace labels use the closest folder for nested resources', () => {
	const root = URI.file('/project');
	const nested = URI.file('/project/src');
	using workspace = new WorkspaceContextService({
		id: 'workspace',
		configuration: URI.file('/project.code-workspace'),
		folders: [
			{ id: 'root', uri: root, name: 'project', index: 0 },
			{ id: 'nested', uri: nested, name: 'src', index: 1 },
		],
	});
	using labels = new LabelService(workspace, OperatingSystem.Linux);
	const resource = URI.file('/project/src/main.ts').with({ query: 'preview' });

	assert.equal(workspace.getWorkspaceFolder(resource)?.id, 'nested');
	assert.equal(labels.getUriLabel(resource, { relative: true }), 'src • main.ts');
	assert.equal(workspace.getWorkspaceFolder(URI.file('/project/src-other/main.ts'))?.id, 'root');
	assert.equal(workspace.getWorkspaceFolder(URI.file('/elsewhere/main.ts')), null);
});


test('a label group updates icon visibility and releases all of its labels', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		using workspace = new WorkspaceContextService({ id: 'test', folders: [] });
		using changes = new Emitter<void>();
		let renders = 0;
		using labels = new ResourceLabels(DEFAULT_LABELS_CONTAINER, {
			workspaceContextService: workspace,
			resourceIconRenderer: { onDidChangeResourceIcons: changes.event, getFileIconTheme: () => ({ ...noFileIconTheme, hasFileIcons: true }), renderFileIcon: (_resource, container) => { renders++; container.textContent = 'F'; } },
		});
		const first = labels.create(dom.window.document.body);
		const coloredIcon = { ...Lxicon.home, color: { id: 'editor.foreground' } };
		first.setLabel('Custom', undefined, { icon: coloredIcon });
		assert.equal(first.element.querySelector<SVGElement>('svg')?.style.color, 'var(--ash-editor-foreground)');
		labels.setIconVisibility(false);
		assert.equal(first.element.querySelector('svg'), null);
		first.setFile(URI.file('/first.ts'));
		const second = labels.create(dom.window.document.body);
		second.setFile(URI.file('/second.ts'));
		assert.deepEqual([...dom.window.document.querySelectorAll('.ash-icon-label-icon')].map(icon => [icon.textContent, icon.classList.contains('is-reserved')]), [['', false], ['', false]]);
		labels.setIconVisibility(true);
		assert.deepEqual([...dom.window.document.querySelectorAll('.ash-icon-label-icon')].map(icon => icon.textContent), ['F', 'F']);
		first.dispose();
		const before = renders;
		changes.fire();
		assert.equal(renders, before + 1);
		labels.dispose();
		changes.fire();
		assert.equal(renders, before + 1);
		assert.equal(dom.window.document.body.childElementCount, 0);
	} finally { dom.window.close(); }
});

test('untitled resource labels follow the draft name and keep the resource identity', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		using services = createTestEditorServices(undefined, undefined, dom.window.document);
		const untitled = services.get(IUntitledTextEditorService);
		using labels = services.get(IResourceLabelService).createGroup();
		const draft = untitled.create();
		const fileLabel = labels.create(dom.window.document.body);
		const resourceLabel = labels.create(dom.window.document.body);
		fileLabel.setFile(draft.resource);
		resourceLabel.setResource({ resource: draft.resource, name: draft.name });
		untitled.rename(draft.resource, 'Scratch');

		assert.deepEqual({
			name: fileLabel.element.querySelector('.ash-icon-label-text')?.textContent,
			resource: draft.resource.toString(),
			accessibleLabel: resourceLabel.element.getAttribute('aria-label'),
		}, { name: 'Scratch', resource: 'untitled:/Untitled-1', accessibleLabel: 'Scratch • /Untitled-1' });
	} finally { dom.window.close(); }
});
