# v0.3.5

## New Features

- Add provider reasoning profiles and cross-provider thinking projection through Pi's existing thinking-level map.
- Expose shared reasoning projection details in registration, doctor, info, and model metadata interfaces.
- Support exact-model user opt-in for reviewed higher reasoning levels.

## Compatibility And Repair

- Centralize provider compatibility resolution so runtime hooks and probes use the same decision.
- Introduce explicit compatibility plans and a repair investigation state machine.
- Keep post-repair switching optional and preserve legacy Pi theme token compatibility without hiding unrelated renderer errors.

## Architecture

- Introduce a narrow Registration Operations module for command, lifecycle, and probe consumers.
- Remove the broad fake runtime test helper and replace it with operation-level test seams.
- Extend the supported `@earendil-works/pi-tui` peer range to include `0.84.2`.

## Validation

- Pass the full Bun test suite, TypeScript typecheck, package dry-run, and isolated TUI smoke checks.
