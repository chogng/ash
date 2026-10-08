import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { getHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { SelectBox } from '../../../../base/browser/ui/selectbox/selectbox.js';
import { ScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import type { SymphonyConversation, SymphonyStatus } from '../../../../platform/symphony/common/symphonyService.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { ViewPane, type IViewPaneOptions } from '../../../../workbench/browser/parts/views/viewPane.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { ISymphonyService } from './symphonyService.js';
import './symphony.css';

export class SymphonyTasksView extends ViewPane {
	private readonly source: InputBox;
	constructor(parent: HTMLElement, options: IViewPaneOptions,
		@ISymphonyService symphony: ISymphonyService,
		@IConfigurationService configuration: IConfigurationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IFileDialogService dialogs: IFileDialogService,
	) {
		super(parent, options);
		const container = this.contentElement;
		container.classList.add('ash-symphony-tasks');
		this._register(contextKeys.createScoped(container)).createKey('sessionsSymphonyFocused', true);
		const document = container.ownerDocument;
		container.append(h(document, 'p', {}, localize('symphony.workflowPath', 'Workflow file')));
		this.source = this._register(new InputBox(container, { ariaLabel: localize('symphony.workflowPath', 'Workflow file'), placeholder: localize('symphony.workflowPlaceholder', '/project/WORKFLOW.md') }));
		const actions = h(document, 'div', { className: 'ash-symphony-actions' });
		container.append(actions);
		const configure = (): void => { if (symphony.available && this.source.value.trim()) { void symphony.configure(this.source.value.trim()); } };
		const load = this._register(new Button(actions, { label: localize('symphony.loadWorkflow', 'Load workflow'), onClick: configure }));
		const choose = this._register(new Button(actions, { label: localize('symphony.chooseFile', 'Choose file'), presentation: 'secondary', onClick: () => {
			void dialogs.showOpenDialog({ title: localize('symphony.chooseFile', 'Choose file'), canSelectFolders: false, canSelectFiles: true, canSelectMany: false, filters: [{ name: 'Markdown', extensions: ['md'] }] }).then(resources => {
				if (!this.isDisposed && resources?.[0]) { this.source.value = resources[0].fsPath; configure(); }
			}).catch(error => { status(String(error)); });
		} }));
		this._register(addDisposableListener(this.source.inputElement, 'keydown', event => { if (event.key === 'Enter') { event.preventDefault(); configure(); } }));
		const picker = this._register(new SelectBox(container, { options: [], ariaLabel: localize('symphony.workflow', 'Workflow'), presentation: 'field' }));
		const enable = this._register(new Button(container, { label: localize('symphony.disableWorkflow', 'Pause dispatch'), presentation: 'secondary', onClick: () => {
			const workflow = symphony.state.get().workflows.find(workflow => workflow.id === picker.value);
			if (workflow) { void symphony.enable(workflow.id, !workflow.enabled); }
		} }));
		container.append(h(document, 'p', { className: 'ash-symphony-muted' }, localize('symphony.dispatchHint', 'Pausing dispatch keeps current conversations running.')));
		const title = this._register(new InputBox(container, { ariaLabel: localize('symphony.taskTitle', 'Task title'), placeholder: localize('symphony.taskTitle', 'Task title') }));
		const prompt = this._register(new InputBox<true>(container, { flexibleHeight: true, ariaLabel: localize('symphony.instructions', 'Instructions'), placeholder: localize('symphony.instructions', 'Instructions') }));
		const create = this._register(new Button(container, { label: localize('symphony.createTask', 'Create task'), presentation: 'primary', onClick: () => {
			const submittedTitle = title.value;
			const submittedPrompt = prompt.value;
			if (picker.value && submittedTitle.trim()) {
				void symphony.submit(picker.value, submittedTitle.trim(), submittedPrompt).then(() => {
					// Submitting includes a refresh; preserve the next draft typed while it completes.
					if (!symphony.state.get().error && title.value === submittedTitle && prompt.value === submittedPrompt) { title.value = ''; prompt.value = ''; }
				});
			}
		} }));
		const error = h(document, 'p', { className: 'ash-symphony-error', attributes: { role: 'status' } });
		const workflowError = h(document, 'p', { className: 'ash-symphony-error', attributes: { role: 'status' } });
		container.append(error, workflowError, h(document, 'h2', {}, localize('symphony.conversations', 'Conversations')));
		const list = h(document, 'div', { className: 'ash-symphony-list', attributes: { role: 'listbox', 'aria-label': localize('symphony.conversations', 'Conversations') }, properties: { tabIndex: 0 } });
		container.append(list);
		const empty = h(document, 'p', { className: 'ash-symphony-muted' }, localize('symphony.noConversations', 'Load a workflow and create a task, or wait for tracker issues.'));
		container.append(empty);
		const rows = new Map<string, { node: HTMLElement; title: HTMLElement; metadata: HTMLElement }>();
		const rowHovers = new Map<string, ReturnType<ReturnType<typeof getHoverDelegate>['setupHover']>>();
		this._register(addDisposableListener(list, 'click', event => {
			const row = (event.target as HTMLElement).closest<HTMLElement>('[data-conversation]');
			if (row?.dataset.conversation) { symphony.select(row.dataset.conversation); list.focus(); }
		}));
		this._register(addDisposableListener(list, 'keydown', event => {
			const items = [...rows.keys()];
			const index = Math.max(0, items.indexOf(symphony.state.get().selected ?? ''));
			const next = event.key === 'ArrowDown' ? Math.min(items.length - 1, index + 1) : event.key === 'ArrowUp' ? Math.max(0, index - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : undefined;
			if (next !== undefined && items[next]) { event.preventDefault(); symphony.select(items[next]); rows.get(items[next])!.node.scrollIntoView({ block: 'nearest' }); }
		}));
		this._register(addDisposableListener(container, 'focusin', event => {
			if (!container.contains(event.relatedTarget as Node) && configuration.getValue<boolean>(AccessibilityVerbositySettingId.Symphony)) { status(localize('symphony.helpHint', 'Press Alt+F1 for Symphony keyboard help.')); }
		}));
		const updateControls = (): void => {
			const state = symphony.state.get();
			load.enabled = choose.enabled = this.source.enabled = symphony.available && !state.loading;
			picker.enabled = enable.enabled = symphony.available && !state.loading && state.workflows.length > 0;
			create.enabled = symphony.available && !state.loading && !!picker.value && !!title.value.trim();
			const workflow = state.workflows.find(workflow => workflow.id === picker.value);
			enable.label = workflow?.enabled ? localize('symphony.disableWorkflow', 'Pause dispatch') : localize('symphony.enableWorkflow', 'Resume dispatch');
			workflowError.textContent = workflow?.error ?? '';
		};
		this._register(title.onDidChange(updateControls));
		this._register(picker.onDidSelect(updateControls));
		this._register(autorun(reader => {
			const state = symphony.state.read(reader);
			const value = picker.value;
			const options = state.workflows.map(workflow => ({ value: workflow.id, label: workflow.path, description: workflow.tracker }));
			if (JSON.stringify(options) !== JSON.stringify(picker.options)) { picker.setOptions(options); picker.value = options.some(option => option.value === value) ? value : options[0]?.value; }
			updateControls();
			error.textContent = state.error ?? '';
			for (const [id, row] of rows) { if (!state.conversations.some(item => item.id === id)) { row.node.remove(); rows.delete(id); rowHovers.get(id)?.dispose(); rowHovers.delete(id); } }
			for (const item of state.conversations) {
				let row = rows.get(item.id);
				if (!row) {
					const node = h(document, 'div', { className: 'ash-symphony-row', attributes: { role: 'option', id: `symphony-${item.id}`, 'data-conversation': item.id } });
					const heading = h(document, 'span', { className: 'ash-symphony-row-title' });
					const metadata = h(document, 'span', { className: 'ash-symphony-muted' });
					node.append(heading, metadata); list.append(node);
					row = { node, title: heading, metadata }; rows.set(item.id, row);
					rowHovers.set(item.id, this._register(getHoverDelegate().setupHover({ target: heading, content: item.title })));
				}
				row.title.textContent = item.title;
				row.metadata.textContent = metrics(item);
				row.node.setAttribute('aria-label', `${item.title}, ${metrics(item)}`);
				row.node.setAttribute('aria-selected', String(item.id === state.selected));

			}
			empty.hidden = state.conversations.length > 0;
			list.setAttribute('aria-activedescendant', state.selected ? `symphony-${state.selected}` : '');
			if (!state.conversations.length) { list.setAttribute('aria-description', localize('symphony.noConversations', 'Load a workflow and create a task, or wait for tracker issues.')); }
			else { list.removeAttribute('aria-description'); }
		}));
		const watching = this._register(new MutableDisposable());
		this._register(this.onDidChangeBodyVisibility(visible => { watching.value = visible ? symphony.watch() : undefined; }));
		if (this.isBodyVisible()) { watching.value = symphony.watch(); }
	}
	public override focus(): void { this.source.focus(); }
}

export class SymphonyMonitorEditor extends EditorPane {
	public readonly id = 'sessions.editor.symphony';
	private domNode!: HTMLElement;
	private readonly watching = this._register(new MutableDisposable());
	constructor(@ISymphonyService private readonly symphony: ISymphonyService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IThemeService theme: IThemeService, @IStorageService storage: IStorageService,
	) { super('sessions.editor.symphony', theme, storage); }
	public override create(parent: HTMLElement): void {
		const document = parent.ownerDocument;
		this.domNode = h(document, 'section', { className: 'ash-symphony-monitor', attributes: { 'aria-label': 'Symphony' }, properties: { tabIndex: 0 } });
		parent.append(this.domNode); super.create(this.domNode);
		this._register(this.contextKeys.createScoped(this.domNode)).createKey('sessionsSymphonyFocused', true);
		const heading = h(document, 'h1');
		const metadata = h(document, 'p', { className: 'ash-symphony-muted' });
		const note = h(document, 'p', { className: 'ash-symphony-muted' }, localize('symphony.cumulative', 'Totals include every run, resume and retry in this conversation. Runtime excludes paused time.'));
		const actions = h(document, 'div', { className: 'ash-symphony-actions' });
		this.domNode.append(heading, metadata, note, actions);
		const pause = this._register(new Button(actions, { label: localize('symphony.pause', 'Pause'), presentation: 'secondary', onClick: () => { const id = this.symphony.state.get().selected; if (id) { void this.symphony.control(id, 'pause'); } } }));
		const resume = this._register(new Button(actions, { label: localize('symphony.resume', 'Resume'), presentation: 'secondary', onClick: () => { const id = this.symphony.state.get().selected; if (id) { void this.symphony.control(id, 'run'); } } }));
		const complete = this._register(new Button(actions, { label: localize('symphony.complete', 'Complete'), presentation: 'secondary', onClick: () => { const id = this.symphony.state.get().selected; if (id) { void this.symphony.control(id, 'complete'); } } }));
		const error = h(document, 'p', { className: 'ash-symphony-error', attributes: { role: 'status' } });
		const blocked = h(document, 'p', { attributes: { role: 'status' } });
		const messages = h(document, 'div', { className: 'ash-symphony-messages', attributes: { role: 'region', 'aria-label': localize('symphony.messages', 'Messages') }, properties: { tabIndex: 0 } });
		this.domNode.append(error, blocked);
		const scrollable = this._register(new ScrollableElement(this.domNode, { horizontal: 'hidden', vertical: 'auto' }));
		scrollable.contentElement.append(messages);
		let previousMessages = '';
		this._register(autorun(reader => {
			const state = this.symphony.state.read(reader);
			const item = state.conversations.find(item => item.id === state.selected);
			heading.textContent = item?.title ?? 'Symphony';
			metadata.textContent = item ? metrics(item) : localize('symphony.empty', 'Load a WORKFLOW.md file to begin.');
			note.hidden = !item;
			pause.hidden = !item || ['paused', 'completed', 'stopping'].includes(item.status);
			resume.hidden = !item || !['paused', 'completed'].includes(item.status);
			complete.hidden = !item || item.status === 'completed';
			pause.enabled = resume.enabled = complete.enabled = !state.loading;
			error.textContent = state.error ?? item?.error ?? '';
			blocked.textContent = item?.status === 'blocked' ? localize('symphony.blockedHint', 'This conversation is waiting for approval or input. Respond in its Chat to continue.') : '';
			const serialized = JSON.stringify([state.selected, state.messages]);
			if (serialized !== previousMessages) {
				const follow = scrollable.scrollableElement.scrollHeight - scrollable.scrollableElement.scrollTop - scrollable.scrollableElement.clientHeight < 48;
				messages.replaceChildren(...state.messages.map(message => {
					const article = h(document, 'article', { className: 'ash-symphony-message' });
					article.append(h(document, 'h2', {}, message.role === 'user' ? localize('symphony.you', 'You') : localize('symphony.assistant', 'Assistant')), h(document, 'p', {}, message.text));
					return article;
				}));
				previousMessages = serialized;
				scrollable.layout();
				if (follow) { scrollable.scrollableElement.scrollTop = scrollable.scrollableElement.scrollHeight; }
			}
		}));
	}
	public override async setInput(_input: IResourceEditorInput, signal: AbortSignal): Promise<void> { signal.throwIfAborted(); this.watching.value = this.symphony.watch(); }
	public override clearInput(): void { this.watching.clear(); }
	public override layout(_dimension: IDimension): void { }
	public override focus(): void { this.domNode.focus(); }
	public override getControl(): HTMLElement { return this.domNode; }
}

export function statusLabel(value: SymphonyStatus): string {
	switch (value) {
		case 'pending': return localize('symphony.pending', 'Queued');
		case 'starting': return localize('symphony.starting', 'Starting');
		case 'running': return localize('symphony.running', 'Running');
		case 'blocked': return localize('symphony.blocked', 'Needs response');
		case 'retrying': return localize('symphony.retrying', 'Retrying');
		case 'stopping': return localize('symphony.stopping', 'Stopping');
		case 'paused': return localize('symphony.paused', 'Paused');
		case 'completed': return localize('symphony.completed', 'Completed');
	}
}
function metrics(item: SymphonyConversation): string {
	const seconds = Math.floor(item.durationMs / 1000);
	const runtime = `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
	return localize('symphony.metrics', '{0} · {1} tokens · {2}', statusLabel(item.status), `${item.tokensComplete ? '' : '≥'}${item.tokens.toLocaleString()}`, runtime);
}
export function symphonyAccessibleContent(service: ISymphonyService): string {
	const state = service.state.get();
	const item = state.conversations.find(item => item.id === state.selected);
	return ['Symphony', state.error, ...state.workflows.map(workflow => `${workflow.path}\n${workflow.error ?? ''}`), ...state.conversations.map(item => `${item.title}\n${metrics(item)}`), item?.error, ...state.messages.map(message => `${message.role === 'user' ? localize('symphony.you', 'You') : localize('symphony.assistant', 'Assistant')}\n${message.text}`)].filter(Boolean).join('\n\n');
}
