## Render-path proof (required for any PR touching a component with early returns)

- [ ] Listed every early return in each changed component (inspect the enclosing component's control flow, not only the changed hunk)
- [ ] `react-hooks/rules-of-hooks` runs as a CI error (it does: `lint` job in `.github/workflows/ci.yml`)
- [ ] Added or updated a same-instance transition smoke test (`e2e/transitions.spec.ts`) for the changed behavior: loading -> loaded, empty -> populated, on ONE mounted instance
- [ ] Per render path: PASS or UNVERIFIED (any unexercised early return = UNVERIFIED)
- [ ] Answered: what renders before data arrives, and which proof step exercised that render?

Claim only what the evidence shows: "the reproduced pattern is caught by enforced lint + the transition regression test." A diff read alone is not UI verification; a first-paint screenshot is not proof of a deferred-data route.

## What changes

## Proof pack
| Claim | Result | Evidence |
|---|---|---|
