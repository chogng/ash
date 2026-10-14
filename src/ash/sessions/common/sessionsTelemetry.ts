import { TelemetryLevel, type ITelemetryService } from '../../platform/telemetry/common/telemetry.js';

export type SessionsInteractionButton = 'openInVSCode';
export type SessionsInteractionSource = 'menu';

type Interaction = { button: SessionsInteractionButton; source?: SessionsInteractionSource; };
type Classification = {
	owner: 'ash'; comment: 'Interactions with Sessions controls; contains no user content or resource identity.';
	button: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Control identifier.'; };
	source?: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Control surface.'; };
};

/** Use the host's existing telemetry policy; this hook does not enable collection. */
export function logSessionsInteraction(telemetry: ITelemetryService, button: SessionsInteractionButton, source?: SessionsInteractionSource): void {
	if (telemetry.telemetryLevel !== TelemetryLevel.USAGE) { return; }
	telemetry.publicLog2<Interaction, Classification>('ashSessions.interaction', source === undefined ? { button } : { button, source });
}
