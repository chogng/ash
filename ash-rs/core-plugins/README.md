# Core Plugins

- Owns Plugin discovery, durable installation and activation state, immutable package storage and invocation leases.
- Registers named Plugin providers, routes exact source IDs, and installs their verified packages.
- Implements the HTTPS/TUF Marketplace provider with independent trust and cache configuration for each source.
- Supplies resolved Skill, MCP, Connector, Hook and Extension contributions to their runtime owners.

Marketplace JavaScript execution consent belongs to `EditorExtensionPolicy`. Enablement and grant are
separate profile-persisted decisions bound to the exact package, capability and host authority version.
Mutations require the observed revision; stale writes fail. A changed host authority version invalidates
old consent. The runtime subscribes to committed changes and retires revoked callbacks before the
policy RPC returns. `Manager::acquire_local_source` pins verified package storage only; it grants no
execution permission and cannot replace the independent runtime admission check.
