import { CancellationToken } from '../../../../base/common/cancellation.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IViewsService } from '../../../services/views/browser/viewsService.js';
import type { OnboardingOutcome } from '../common/onboardingScenario.js';
import { IOnboardingScenarioService } from '../common/onboardingScenarioService.js';
import { type IOnboardingTryout, type IOnboardingTryoutService, onboardingTryoutRegistry, parseOnboardingTryoutLink } from '../common/onboardingTryout.js';
import { localize } from '../../../../nls.js';

export class OnboardingTryoutService implements IOnboardingTryoutService {
	constructor(
		@IOnboardingScenarioService private readonly onboarding: IOnboardingScenarioService,
		@ICommandService private readonly commands: ICommandService,
		@IViewsService private readonly views: IViewsService,
		@IDialogService private readonly dialogs: IDialogService,
		@INotificationService private readonly notifications: INotificationService,
	) {}

	public getTryouts(): readonly IOnboardingTryout[] {
		return onboardingTryoutRegistry.getTryouts();
	}

	public async run(id: string, token: CancellationToken = CancellationToken.None): Promise<OnboardingOutcome> {
		const tryout = onboardingTryoutRegistry.get(id);
		if (token.isCancellationRequested) return 'cancelled';
		if (!tryout) return 'unavailable';
		if (!await this.isAvailable(id, token)) {
			if (token.isCancellationRequested) return 'cancelled';
			if (tryout.setup) {
				this.notifications.info(tryout.unavailableMessage ?? localize('onboarding.tryoutUnavailable', 'This example is unavailable.'), [{
					id: `onboarding.setup.${id}`,
					label: tryout.setup.label,
					run: () => this.commands.executeCommand(tryout.setup!.commandId),
				}]);
			}
			return 'unavailable';
		}
		if (token.isCancellationRequested) return 'cancelled';
		const presentation = tryout.presentation;
		switch (presentation.kind) {
			case 'command':
				if (!CommandsRegistry.hasCommand(presentation.commandId) || !await this.isAvailable(id, token)) return token.isCancellationRequested ? 'cancelled' : 'unavailable';
				if (token.isCancellationRequested) return 'cancelled';
				await this.commands.executeCommand(presentation.commandId, ...(presentation.arguments ?? []));
				return 'completed';
			case 'openView':
				if (!await this.isAvailable(id, token)) return token.isCancellationRequested ? 'cancelled' : 'unavailable';
				if (token.isCancellationRequested) return 'cancelled';
				return this.views.focusView(presentation.viewId) ? 'completed' : 'unavailable';
			case 'guided': {
				const scope = await presentation.prepare?.(token);
				if (token.isCancellationRequested) return 'cancelled';
				if (!await this.isAvailable(id, token)) return token.isCancellationRequested ? 'cancelled' : 'unavailable';
				if (token.isCancellationRequested) return 'cancelled';
				return this.onboarding.showSteps(presentation.steps, token, scope || undefined);
			}
		}
	}

	public async openLink(href: string, token: CancellationToken = CancellationToken.None): Promise<OnboardingOutcome> {
		const id = parseOnboardingTryoutLink(href);
		const tryout = id && onboardingTryoutRegistry.get(id);
		if (token.isCancellationRequested) return 'cancelled';
		if (!tryout) return 'unavailable';
		const confirmed = await this.dialogs.confirm({
			title: tryout.title,
			message: tryout.description,
			primaryButton: localize('onboarding.tryoutConfirm', 'Try it'),
		});
		if (!confirmed || token.isCancellationRequested) return 'cancelled';
		return this.run(id, token);
	}

	private async isAvailable(id: string, token: CancellationToken): Promise<boolean> {
		const tryout = onboardingTryoutRegistry.get(id);
		if (!tryout || token.isCancellationRequested) return false;
		try {
			return await tryout.isAvailable?.(token) ?? true;
		} catch (error) {
			console.error(`Unable to check onboarding tryout '${id}'`, error);
			return false;
		}
	}
}
