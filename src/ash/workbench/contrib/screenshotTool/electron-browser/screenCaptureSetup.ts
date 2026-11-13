import { Emitter } from '../../../../base/common/event.js';
import { h, addDisposableListener } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { createWorkbenchDialogOptions } from '../../../browser/parts/dialogs/dialog.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { INativeHostService } from '../../../common/services.js';
import type { INativeHostApi } from '../../../../platform/native/common/nativeHost.js';
import { createServiceIdentifier, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import './media/screenCaptureSetup.css';

export interface IScreenCaptureSetupOptions {
	readonly title: string;
	readonly description: string;
	readonly help: string;
	readonly providerId: AccessibleViewProviderId;
	readonly verbositySetting: AccessibilityVerbositySettingId;
}

export interface IScreenCaptureSetupService {
	show(options: IScreenCaptureSetupOptions, signal: AbortSignal): Promise<void>;
}
export const IScreenCaptureSetupService = createServiceIdentifier<IScreenCaptureSetupService>('screenCaptureSetupService');

/** One permission setup per Workbench window; the originating operation owns its cancellation. */
export class ScreenCaptureSetupService extends Disposable implements IScreenCaptureSetupService {
	private readonly lifetime = new AbortController();
	private pending: Promise<void> | undefined;
	constructor(
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@INativeHostService private readonly native: INativeHostApi,
	) { super(); }
	show(options: IScreenCaptureSetupOptions, signal: AbortSignal): Promise<void> {
		if (signal.aborted || this.isDisposed) return Promise.resolve();
		if (this.pending) return this.pending;
		const requestSignal = AbortSignal.any([signal, this.lifetime.signal]);
		const operation = this.open(options, requestSignal).finally(() => { if (this.pending === operation) this.pending = undefined; });
		return this.pending = operation;
	}
	private async open(options: IScreenCaptureSetupOptions, signal: AbortSignal): Promise<void> {
		await this.native.focusWindow();
		if (signal.aborted) return;
		const permission = await this.native.getMediaAccessStatus('screen');
		if (signal.aborted || permission === 'granted') return;
		using dialog = this.instantiation.createInstance(ScreenCaptureSetupDialog, permission, options);
		if (signal.aborted) return;
		using cancellation = addDisposableListener(signal, 'abort', () => dialog.dispose(), { once: true });
		await dialog.show();
	}
	protected override disposeCore(): void { this.lifetime.abort(); super.disposeCore(); }
}

/** Permission setup observes focus and permission only; completing setup never captures pixels. */
class ScreenCaptureSetupDialog extends Disposable {
	private readonly contentChanged = this._register(new Emitter<void>());
	private readonly dialog: Dialog;
	private readonly body: HTMLElement;
	private readonly permissionText: HTMLElement;
	private readonly guidance: HTMLElement;
	private readonly error: HTMLElement;
	private readonly allow: Button;
	private readonly recheck: Button;
	private readonly restart: Button;
	private readonly closeWhenAllowed = this._register(new RunOnceScheduler(() => this.dialog.dispose(), 600));
	private visitedSettings = false;
	private leftWindow = false;
	private returned = false;
	private checking = false;
	private allowing = false;

	constructor(
		private permission: Awaited<ReturnType<INativeHostApi['getMediaAccessStatus']>>,
		private readonly options: IScreenCaptureSetupOptions,
		@ILayoutService layout: ILayoutService,
		@INativeHostService private readonly native: INativeHostApi,
		@IHostService private readonly host: IHostService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@ILogService private readonly log: ILogService,
	) {
		super();
		const document = layout.activeContainer.ownerDocument;
		this.body = h(document, 'div', { className: 'ash-screen-capture-setup' });
		const description = h(document, 'p');
		description.textContent = options.description;
		this.permissionText = h(document, 'p', { attributes: { role: 'status', 'aria-live': 'polite' } });
		this.guidance = h(document, 'p');
		const controls = h(document, 'div', { className: 'ash-screen-capture-setup-actions' });
		this.error = h(document, 'p', { attributes: { role: 'alert' } });
		this.body.append(description, this.permissionText, this.guidance, controls, this.error);
		this.allow = this._register(new Button(controls, { ...defaultButtonStyles, label: localize('appWindowScreenshotSetup.allow', 'Allow in Settings') }));
		this.recheck = this._register(new Button(controls, { ...defaultButtonStyles, label: localize('appWindowScreenshotSetup.recheck', 'Check Again'), presentation: 'secondary' }));
		this.restart = this._register(new Button(controls, { ...defaultButtonStyles, label: localize('appWindowScreenshotSetup.restart', 'Restart Ash') }));
		this._register(this.allow.onDidClick(() => { void this.openSettings(); }));
		this._register(this.recheck.onDidClick(() => { void this.checkPermission(); }));
		this._register(this.restart.onDidClick(() => { void host.restart().catch(error => this.showError(error)); }));
		this.dialog = this._register(new Dialog(layout.activeContainer, options.title, [localize('appWindowScreenshotSetup.close', 'Close')], createWorkbenchDialogOptions({
			layout: 'form', cancelId: 0, disableDefaultAction: true,
			extraClasses: ['ash-screen-capture-setup-dialog'],
			renderBody: container => container.append(this.body),
		})));
		const handleFocus = (focused: boolean): void => {
			if (!this.visitedSettings) { return; }
			if (!focused) { this.leftWindow = true; }
			else if (this.leftWindow) {
				this.leftWindow = false;
				this.returned = true;
				void this.checkPermission();
			}
		};
		this._register(host.onDidChangeFocus(handleFocus));
		const window = document.defaultView!;
		this._register(addDisposableListener(window, 'blur', () => handleFocus(false)));
		this._register(addDisposableListener(window, 'focus', () => handleFocus(true)));
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				name: 'screenCaptureSetup', priority: 120, type,
				getProvider: () => {
					if (!this.body.closest('dialog')?.contains(document.activeElement)) { return undefined; }
					const focused = document.activeElement as HTMLElement | null;
					const provider = new AccessibleContentProvider(this.options.providerId, { type }, () => type === AccessibleViewType.Help
						? this.options.help
						: this.body.textContent ?? '', () => {
							if (this.isDisposed) { return; }
							if (focused?.isConnected && !focused.closest('[hidden]')) { focused.focus(); }
							else { this.recheck.domNode.focus(); }
						}, this.options.verbositySetting);
					if (type === AccessibleViewType.View) { provider.onDidChangeContent = this.contentChanged.event; }
					return provider;
				},
			}));
		}
		this.render();
	}

	public async show(): Promise<void> {
		const closed = this.dialog.show();
		if (this.configuration.getValue<boolean>(this.options.verbositySetting) !== false) {
			status(localize('screenshot.setup.helpHint', 'Screenshot setup. Accessibility Help describes the permission controls.'));
		}
		await closed;
	}
	private render(): void {
		const allowed = this.permission === 'granted';
		const restricted = this.permission === 'restricted';
		this.permissionText.textContent = allowed ? localize('appWindowScreenshotSetup.allowed', 'Screen Recording: Allowed')
			: restricted ? localize('appWindowScreenshotSetup.restricted', 'Screen Recording: Restricted')
				: localize('appWindowScreenshotSetup.notAllowed', 'Screen Recording: Not allowed');
		this.guidance.textContent = restricted ? localize('appWindowScreenshotSetup.restrictedDescription', 'Screen Recording is restricted on this Mac. Contact the administrator to allow access.')
			: this.returned && !allowed ? localize('appWindowScreenshotSetup.restartDescription', 'If Screen Recording was enabled in System Settings, restart Ash to apply it.')
				: localize('appWindowScreenshotSetup.settingsDescription', 'In System Settings, enable Ash under Privacy & Security, Screen Recording.');
		this.allow.domNode.hidden = allowed || restricted;
		this.allow.label = this.returned ? localize('appWindowScreenshotSetup.openSettings', 'Open Settings') : localize('appWindowScreenshotSetup.allow', 'Allow in Settings');
		this.restart.domNode.hidden = allowed || restricted || !this.returned;
		this.recheck.enabled = !this.checking;
		this.allow.enabled = !this.allowing;
		if (allowed) { this.closeWhenAllowed.schedule(); }
		this.contentChanged.fire();
	}
	private async openSettings(): Promise<void> {
		if (this.allowing || this.isDisposed) { return; }
		this.allowing = true;
		this.visitedSettings = true;
		this.render();
		try { await this.native.requestScreenCaptureAccess(); }
		catch (error) { if (!this.isDisposed) { this.showError(error); } }
		finally { this.allowing = false; if (!this.isDisposed) { this.render(); } }
	}
	private async checkPermission(): Promise<void> {
		if (this.checking || this.isDisposed) { return; }
		this.checking = true;
		this.render();
		try {
			const permission = await this.native.getMediaAccessStatus('screen');
			if (this.isDisposed) { return; }
			this.permission = permission;
			this.error.textContent = '';
		} catch (error) { if (!this.isDisposed) { this.showError(error); } }
		finally { this.checking = false; if (!this.isDisposed) { this.render(); } }
	}
	private showError(error: unknown): void {
		if (this.isDisposed) { return; }
		this.log.error('screenCaptureSetup', 'Could not update screen recording access', error);
		this.error.textContent = localize('appWindowScreenshotSetup.failed', 'Could not update Screen Recording access. Try again.');
		this.contentChanged.fire();
	}
}
