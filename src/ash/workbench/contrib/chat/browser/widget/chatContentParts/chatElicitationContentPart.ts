import { h } from '../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import type { AgentInteractionDecision, PermissionRequest } from '../../../../../../platform/agentHost/common/agent.js';
import { workspaceTrustPermissionNames } from '../../../../../../platform/workspace/common/workspaceTrust.js';
import { ChatConfirmationWidget } from './chatConfirmationWidget.js';

/** Lets a user answer an environment's permission request using the shared confirmation form. */
export class ChatElicitationContentPart extends Disposable {
	readonly domNode: HTMLFormElement;

	constructor(document: Document, request: PermissionRequest, resolve: (response: AgentInteractionDecision) => Promise<void>) {
		super();
		const widget = this._register(new ChatConfirmationWidget(document));
		const form = this.domNode = widget.domNode;
		const heading = h(document, 'p');
		heading.textContent = localize('chat.permissions.environment', 'Permissions in {0}', request.environmentId);
		const reason = h(document, 'p');
		reason.textContent = request.reason;
		form.append(heading, reason);
		const directories = request.directories.map(entry => {
			const group = h(document, 'fieldset');
			const legend = h(document, 'legend');
			legend.textContent = entry.path;
			group.append(legend);
			const permissions = entry.permissions.map(permission => {
				const label = h(document, 'label');
				const input = h(document, 'input');
				input.type = 'checkbox';
				const name = localize({ bundle: 'ash.settings', key: `capabilities.permission.${permission}` }, workspaceTrustPermissionNames[permission]);
				label.append(input, document.createTextNode(name));
				group.append(label);
				return { permission, input };
			});
			form.append(group);
			return { path: entry.path, permissions };
		});
		const hosts = request.networkHosts.map(host => {
			const label = h(document, 'label');
			const input = h(document, 'input');
			input.type = 'checkbox';
			label.append(input, document.createTextNode(localize('chat.permissions.networkHost', 'Access network: {0}', host)));
			form.append(label);
			return { host, input };
		});
		const durationLabel = h(document, 'label');
		durationLabel.textContent = localize('chat.permissions.duration', 'Permission duration');
		const duration = h(document, 'select');
		const turnOption = h(document, 'option');
		turnOption.value = 'turn';
		turnOption.textContent = localize('chat.permissions.turn', 'This turn');
		duration.append(turnOption);
		if (request.duration === 'session') {
			const sessionOption = h(document, 'option');
			sessionOption.value = 'session';
			sessionOption.textContent = localize('chat.permissions.session', 'This session');
			duration.append(sessionOption);
		}
		durationLabel.append(duration);
		form.append(durationLabel);
		widget.setActions(
			localize('chat.approval.decline', 'Decline'),
			localize('chat.permissions.approveSelected', 'Approve selected'),
			() => resolve({ type: 'permissions', response: { duration: 'turn', directories: [], networkHosts: [] } }),
			() => resolve({
				type: 'permissions',
				response: {
					duration: duration.value === 'session' ? 'session' : 'turn',
					directories: directories.map(entry => ({
						path: entry.path,
						permissions: entry.permissions.filter(value => value.input.checked).map(value => value.permission),
					})).filter(entry => entry.permissions.length > 0),
					networkHosts: hosts.filter(value => value.input.checked).map(value => value.host),
				},
			}),
		);
	}
}
