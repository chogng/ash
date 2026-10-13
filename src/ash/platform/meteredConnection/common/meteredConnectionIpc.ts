export const METERED_CONNECTION_CHANNEL = 'meteredConnection';

export enum MeteredConnectionCommand {
	OnDidChangeIsConnectionMetered = 'OnDidChangeIsConnectionMetered',
	IsConnectionMetered = 'IsConnectionMetered',
	SetIsBrowserConnectionMetered = 'SetIsBrowserConnectionMetered',
}
