# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v`; `gh` does this automatically inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** Set to `yes` if this repo treats external PRs as feature requests.

When set to `yes`, PRs run through the same labels and states as issues, using `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>`.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`, keeping only `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE`.
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs. Resolve bare `#42` with `gh pr view 42`, then fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The map is one issue with child issues as tickets.

- **Map**: issue labelled `wayfinder:map`, holding Notes / Decisions-so-far / Fog. Create with `gh issue create --label wayfinder:map`.
- **Child ticket**: link to map as a GitHub sub-issue. If unavailable, add child to map task list and put `Part of #<map>` at top of child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Assign claimed ticket to driving dev.
- **Blocking**: use GitHub native issue dependencies. Add with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where ID comes from `gh api repos/<owner>/<repo>/issues/<n> --jq .id`. If unavailable, use `Blocked by: #<n>, #<n>` at top of child body.
- **Frontier query**: list map's open children, dropping assigned tickets and tickets with open blockers. First in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`.
- **Resolve**: comment with answer, close ticket, then append context pointer to map's Decisions-so-far.
