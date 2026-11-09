# Optimized Prompt Suite — Testing Index

Skills in `.claude/skills/` for eic1. Each was distilled from the opt-prompts sets (1–4). This file is the index for the suite; add a row when a skill is added.

## Source and synchronization

This is the eic1 project copy. The corresponding homebase proposal is
[homebase PR #77](https://github.com/adamaslan/homebase/pull/77), reviewed here at
commit `b650aa5ed568c3875b92c62828ba5a5a1fc48f73`. Its index has the same ten skill
names. Neither copy establishes that the original opt-prompts sets are available,
nor that either repository is the user's chosen canonical source.

Keep eic1-specific changes here and document any intentional difference when
synchronizing the two copies. Compare the actual files before copying changes;
do not silently overwrite a newer project-specific version. A cross-repository
canonical-source choice is still open. These documents are guidance, not permission
to change accounts, spend money, migrate data or override the user's instructions.

The frontmatter check below is structural only. Live skill invocation remains
unverified; no successful invocation is claimed by this PR.

## Skills

| Skill | Use when |
|---|---|
| evidence-gated-delivery | Shipping a change with proof: evidence packs, test-first fixes, UI runtime proof, PR gatekeeping |
| feature-gating-safety | Flag-first rollouts, safety audits, canary/rollback plans |
| ai-code-debugging | Reviewing AI-written code for failure modes; evidence-first debugging |
| debug-lifecycle-early | Start of a bug: triage, reproduction, evidence, write-path trace |
| debug-lifecycle-late | Bug after repro: hypotheses, root cause, fix, verification, postmortem |
| planning-framing-options | Framing a goal, assumptions register, options, decision record |
| planning-handoff-review | Milestone plans, session briefs for fresh agents, checkpoint reviews |
| codebase-build-refactor | Mapping an unfamiliar repo, impact analysis, specs, safe refactors |
| testing-perf-cost | Test gap/mutation checks, measure-before-optimize, cost audits |
| ops-security-data-delegation-docs | Data/security/ops reviews, incidents, delegation, docs and status updates |

## Suite checks

Run these when the suite changes:

```bash
for d in .claude/skills/*/; do n=$(basename "$d"); grep -q "^name: $n$" "$d/SKILL.md" && echo "ok $n" || echo "BAD $n"; done
```

Expect every line to start with `ok`. A `BAD` line means the frontmatter `name` does not match its folder, so the skill will not load under that name.

## Growing the suite

1. Add `.claude/skills/<name>/SKILL.md` with frontmatter `name` equal to the folder name.
2. Add a row to the table above.
3. Run the suite check.
