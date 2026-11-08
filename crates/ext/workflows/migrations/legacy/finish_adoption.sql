-- Historical run-keyed stores reused command identities across runs.
DROP INDEX IF EXISTS agent_parallel_command_identity;
