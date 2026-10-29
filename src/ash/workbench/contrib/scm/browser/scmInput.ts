import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { h } from '../../../../base/browser/dom.js';
import { DEFAULT_FONT_FAMILY } from '../../../../base/browser/fonts.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import type { IAction } from '../../../../base/common/actions.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { isCancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { TextModel } from '../../../../editor/common/model/textModel.js';
import { localize } from '../../../../nls.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import {
	IContextKeyService,
	type IScopedContextKeyService,
} from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IMenuService, MenuId, type IMenu } from '../../../../platform/actions/common/actions.js';
import { ISCMViewService, type ISCMInput, type ISCMRepository } from '../common/scm.js';
import './media/scm.css';

/** Owns the editing surface; the SCM provider retains the repository's commit draft. */
export class SCMInputWidget extends Disposable {
	public readonly domNode: HTMLDivElement;
	private readonly model = this._register(new TextModel('', { languageId: 'plaintext' }));
	private readonly editor: CodeEditorWidget;
	private readonly editorDomNode: HTMLDivElement;
	private readonly actionButton: Button;
	private readonly inputMenu: IMenu;
	private readonly inputContext: IScopedContextKeyService;
	private runningAction: CancellationTokenSource | undefined;
	private boundInput: ISCMInput | undefined;
	private boundRepository: ISCMRepository | undefined;
	private height = 24;

	constructor(
		container: HTMLElement,
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IMenuService menuService: IMenuService,
		@ISCMViewService private readonly scmViewService: ISCMViewService,
	) {
		super();
		this.domNode = h(container.ownerDocument, 'div');
		this.domNode.className = 'ash-scm-input';
		this.editorDomNode = h(container.ownerDocument, 'div');
		this.editorDomNode.className = 'ash-scm-input-editor';
		this.editorDomNode.style.height = `${this.height}px`;
		this.domNode.append(this.editorDomNode);
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		// Create the enclosing scope before the editor so its focused context inherits SCM help.
		const context = this._register(contextKeyService.createScoped(this.domNode));
		this.inputContext = context;
		this.inputMenu = this._register(menuService.createMenu(MenuId.SCMInputBox, context));
		this.actionButton = this._register(
			new Button(this.domNode, {
				...defaultButtonStyles,
				label: localize('scm.input.generate', 'Generate commit message'),
				icon: Lxicon.sparkle,
				iconOnly: true,
				size: 'small',
				enabled: false,
			}),
		);
		this.actionButton.toggleClassName('ash-scm-input-action', true);
		this._register(
			this.actionButton.onDidClick(() => {
				void this.runInputAction();
			}),
		);
		this._register(this.inputMenu.onDidChange(() => this.updateInputAction()));
		this._register(toDisposable(() => this.cancelInputAction()));
		const focused = context.createKey<boolean>('scmInputIsFocused', false);
		this.editor = this._register(
			instantiationService.createInstance(CodeEditorWidget, {
				container: this.editorDomNode,
				model: this.model,
				isSimpleWidget: true,
				presentation: 'embedded',
				fontFamily: DEFAULT_FONT_FAMILY,
				fontSize: 13,
				lineHeight: 20,
				wordWrap: 'on',
				padding: { top: 2, bottom: 2 },
				lineDecorationsWidth: 0,
				glyphMargin: false,
				folding: false,
				overviewRulerLanes: 0,
				scrollBeyondLastLine: false,
				tabFocusMode: true,
				readOnly: true,
				ariaLabel: localize('scm.input.label', 'Commit message'),
				contributionIds: ['editor.contrib.placeholderText'],
			}),
		);
		this._register(
			this.editor.onDidFocusEditorText(() => {
				focused.set(true);
				this.domNode.classList.add('focused');
			}),
		);
		this._register(
			this.editor.onDidBlurEditorText(() => {
				focused.set(false);
				this.domNode.classList.remove('focused');
			}),
		);
		const layout = this._register(new RunOnceScheduler(() => this.layout(), 0));
		this._register(
			this.model.onDidChangeContent(() => {
				if (this.boundInput) {
					this.boundInput.value = this.model.getText();
				}
				layout.schedule();
			}),
		);
		this._register(
			this.configurationService.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration(AccessibilityVerbositySettingId.ScmInput)) {
					this.updateAriaLabel();
				}
			}),
		);
		const observer = new ResizeObserver(() => layout.schedule());
		this._register(toDisposable(() => observer.disconnect()));
		observer.observe(this.editorDomNode);
		this.updateAriaLabel();
		this.updateInputAction();
		layout.schedule();
	}

	public get input(): ISCMInput | undefined {
		return this.boundInput;
	}

	public set input(input: ISCMInput | undefined) {
		const repository = input ? this.scmViewService.activeRepository : undefined;
		if (repository !== this.boundRepository) {
			this.cancelInputAction();
		}
		this.boundRepository = repository;
		this.boundInput = input;
		const provider = repository?.provider;
		this.inputContext.bufferChangeEvents(() => {
			this.inputContext.setContext('scmProvider', provider?.providerId ?? '');
			this.inputContext.setContext('scmProviderRootUri', provider?.rootUri?.toString() ?? '');
			this.inputContext.setContext('scmProviderHasRootUri', !!provider?.rootUri);
		});
		const value = input?.value ?? '';
		if (this.model.getText() !== value) {
			this.model.setValue(value);
		}
		this.editor.updateOptions({ placeholder: input?.placeholder ?? '', readOnly: !input?.enabled });
		this.updateInputAction();
		this.layout();
	}

	public focus(): void {
		this.editor.focus();
	}

	public getContentHeight(): number {
		const lineHeight = this.editor.getOption(EditorOption.lineHeight);
		const padding = this.editor.getOption(EditorOption.padding);
		// Content height includes the viewport; the last line's bottom also lets the input shrink after deletion.
		const contentHeight = this.editor.getBottomForLineNumber(this.model.lineCount) + padding.bottom;
		return Math.min(
			10 * lineHeight + padding.top + padding.bottom,
			Math.max(lineHeight + padding.top + padding.bottom, contentHeight),
		);
	}

	public layout(): void {
		const width = this.editorDomNode.clientWidth;
		if (width === 0) {
			return;
		}
		this.editor.layout({ width, height: this.height });
		const height = this.getContentHeight();
		if (height !== this.height) {
			this.height = height;
			this.editorDomNode.style.height = `${height}px`;
			this.editor.layout({ width, height });
		}
	}

	private updateAriaLabel(): void {
		let ariaLabel = localize('scm.input.label', 'Commit message');
		if (this.configurationService.getValue<boolean>(AccessibilityVerbositySettingId.ScmInput)) {
			ariaLabel = localize('scm.input.helpHint', '{0}. Press Alt+F1 for source control input help.', ariaLabel);
		}
		this.editor.updateOptions({ ariaLabel });
	}

	private getInputAction(): IAction | undefined {
		return this.inputMenu.getActions({ shouldForwardArgs: true }).flatMap(([, actions]) => actions)[0];
	}

	private updateInputAction(): void {
		const running = this.runningAction !== undefined;
		const action = this.getInputAction();
		const provider = this.boundRepository?.provider;
		this.actionButton.label = running
			? localize('scm.input.stop', 'Stop generating commit message')
			: (action?.label ?? localize('scm.input.generate', 'Generate commit message'));
		this.actionButton.icon = running ? Lxicon.stopCircle : Lxicon.sparkle;
		this.actionButton.enabled = running
			? !this.runningAction!.token.isCancellationRequested
			: !!action?.enabled &&
				!!provider &&
				this.boundInput?.enabled === true &&
				!provider.isBusy &&
				provider.groups.some(group => group.resources.length > 0);
		this.actionButton.setTitle(
			running
				? this.actionButton.label
				: action?.tooltip ||
						(action
							? this.actionButton.label
							: localize('scm.input.generatorUnavailable', 'No commit message generator configured')),
		);
		this.domNode.setAttribute('aria-busy', String(running));
	}

	private async runInputAction(): Promise<void> {
		if (this.runningAction) {
			this.runningAction.cancel();
			this.updateInputAction();
			status(localize('scm.input.stopping', 'Stopping commit message generation'));
			return;
		}
		if (!this.actionButton.enabled) {
			return;
		}
		const action = this.getInputAction();
		const repository = this.boundRepository;
		if (!action || !repository) {
			return;
		}
		const cancellation = new CancellationTokenSource();
		this.runningAction = cancellation;
		this.updateInputAction();
		status(localize('scm.input.generating', 'Generating commit message'));
		try {
			// Capture the repository and resource scope at invocation; switching repositories cancels this request.
			const resources = repository.provider.groups.map(group => ({
				resourceGroupId: group.id,
				resources: group.resources.map(resource => resource.sourceUri),
			}));
			await action.run(repository.provider.rootUri, resources, cancellation.token);
		} catch (error) {
			if (!cancellation.token.isCancellationRequested && !isCancellationError(error)) {
				onUnexpectedError(error);
			}
		} finally {
			if (this.runningAction === cancellation) {
				this.runningAction = undefined;
				this.updateInputAction();
			}
			cancellation.dispose();
		}
	}

	private cancelInputAction(): void {
		this.runningAction?.dispose(true);
		this.runningAction = undefined;
	}
}
