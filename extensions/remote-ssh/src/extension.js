import { workspace } from '@ash/extension';

/** The V8 host owns registration lifetime; the connection host owns execution. */
export function activate(context) {
	context.subscriptions.push(workspace.registerRemoteConnectionResolver('ssh', {
		resolve(_call, authority) {
			return { connectionName: authority.slice(4) };
		},
	}));
}
