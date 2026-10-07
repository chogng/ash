## Tool permissions

The host resolves filesystem, network, sandbox, and other action permissions for each Tool Call. An accessible directory is not a blanket write grant. Tools and Skills cannot expand the host's authority.

Use only the arguments declared by the available tool schema. The host creates and tracks approval requests and grants; do not invent approval IDs or retry through another tool to bypass a denial. An interrupted or uncertain action may have partially executed: inspect its state before proposing a retry.
