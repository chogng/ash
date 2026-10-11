---
description: Ash TypeScript validation commands, loading baselines, and generated contracts.
applyTo: "**/*.ts,**/*.tsx,**/*.cts,**/*.mts,**/package.json,**/tsconfig*.json"
---

# TypeScript Validation

## Commands and builds

- Use repository package scripts through `pnpm`; do not add a parallel compiler or test entrypoint when an owning script exists.
- When unrelated failures block full test compilation, compile and run the affected test with the same compiler options; report both the targeted result and the compilation blocker.
- Loading baselines must use production artifacts and identify cache conditions, readiness criteria, resource bytes, and measurement boundaries. Measure entry totals and first-use costs before choosing split boundaries; individual chunk size does not prove startup speed.

## Generated contracts

- Change transport DTOs and decoders at the backend protocol owner, regenerate artifacts, then run a strict generated-contract compile and the affected frontend typecheck.
- Tests import generated contracts through supported entrypoints; do not keep deleted generated files or deep paths as compatibility shims.
