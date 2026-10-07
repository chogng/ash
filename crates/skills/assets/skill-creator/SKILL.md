---
name: skill-creator
description: Creates or updates concise, valid Agent Skills for Ash. Use when the user asks to design, scaffold, validate, or revise a SKILL.md workflow or its scripts, references, and assets.
---

# Skill creator

Create a Skill that adds reusable procedural knowledge without claiming new authority.

## Establish the contract

1. Identify concrete example requests that should trigger the Skill.
2. Identify nearby requests that should not trigger it.
3. Confirm whether this is a new Skill or an update, and resolve its destination from the user's
   requested source or workspace context.
4. Inspect an existing Skill before changing it. Preserve unrelated content and resources.

## Choose the smallest useful package

Every Skill needs only `SKILL.md`. Add optional directories when they materially improve reuse:

- `scripts/` for deterministic helpers that would otherwise be rewritten repeatedly;
- `references/` for detailed documentation loaded only when needed;
- `assets/` for templates or static files used in generated output.

Do not add a README, changelog, installation guide, placeholder resource, or duplicate reference.
Keep references directly reachable from `SKILL.md` and avoid deep reference chains.

## Write `SKILL.md`

- Use a directory name and frontmatter `name` containing 1–64 lowercase ASCII letters, digits, and
  single hyphens. They must match exactly.
- Write a non-empty `description` of at most 1024 characters that says both what the Skill does and
  when it should trigger. Put trigger information here because discovery does not load the body.
- Prefer only `name` and `description` for broad compatibility. When necessary, Ash also accepts
  `license`, bounded free-text `compatibility`, string-map `metadata`, and experimental
  `allowed-tools`.
- Keep the body concise, imperative, and focused on knowledge a capable agent would not reliably
  infer without the Skill.
- Put variant-specific or lengthy material in an on-demand reference instead of expanding the main
  body.

## Preserve Ash authority boundaries

- Skill instructions remain below system, developer, product, workspace, and current user
  instructions.
- `allowed-tools` describes author intent; it never grants approval, credentials, filesystem,
  network, process, or sandbox capability.
- A file under `scripts/` is inert content. Running it still requires the ordinary Tool,
  authorization, and sandbox path.
- Do not include secrets, host-private absolute paths, dependency installers, setup hooks, or
  instructions that bypass policy.
- Creating files does not install, enable, or activate the Skill. Report the created location and
  leave source registration to the owning configuration or package workflow.

## Validate

Before finishing:

1. Check frontmatter delimiters, field types, name rules, directory-name equality, and description
   quality.
2. Check that all referenced relative files exist and remain inside the Skill root.
3. Reject symbolic links, hard links, special files, traversal, and unexpectedly large content.
4. Run an already-available Agent Skills validator when practical, but do not install or download
   one without user authorization.
5. Re-read the Skill from a fresh-agent perspective and remove context that is generic, redundant,
   or unrelated to its triggers.

Summarize the Skill's location, trigger contract, included resources, and validation performed.
