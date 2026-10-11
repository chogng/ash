---
description: Use when asked to work on telemetry events
---

# Telemetry events

- Use `ITelemetryService.publicLog2<Event, Classification>` for events and `publicLogError2<Event, Classification>` for errors. Declare both event and classification types.
- Every field classification includes `classification`, `purpose` and a comment naming the value and collection reason. Event metadata includes the owner's GitHub username and an event comment.
- Numeric metrics and flags used in calculations require `isMeasurement: true`.

## Classifications and purposes

| Classification | Data |
| --- | --- |
| `SystemMetaData` | Non-personal system information, preferences, feature identifiers, counts and metrics. |
| `CallstackOrException` | Actual error messages, stack traces and exception details. |
| `PublicNonPersonalData` | Already-public non-personal data. |

Choose the most restrictive applicable classification. Use `FeatureInsight` for feature usage and `PerformanceAndHealth` for errors, performance and diagnostics.

## Naming and privacy

- Event names use contextual camelCase, such as `chatMessageSent`; fields identify their meaning and units, such as `agentId` or `durationMs`.
- Do not collect usernames, emails, file paths or user content. Collect only fields needed for the declared purpose; prefer categories or hashes over raw values where applicable.
