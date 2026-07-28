/** Auto-captured Claude Code tool schemas for anyrouter fingerprint padding. */
export type BundledClaudeTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export const BUNDLED_CLAUDE_CODE_TOOLS: BundledClaudeTool[] = [
  {
    "name": "Agent",
    "description": "Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it.\n\nAvailable agent types are listed in <system-reminder> messages in the conversation.\n\nWhen using the Agent tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.\n\n## When to use\n\nReach for this when the task matches an available agent type, when you have independent work to run in parallel, or when answering would mean reading across several files — delegate it and you keep the conclusion, not the file dumps. For a single-fact lookup where you already know the file, symbol, or value, search directly. Once you've delegated a search, don't also run it yourself — wait for the result.\n\n- The agent's final report is not shown to the user — relay what matters.\n- Use SendMessage with the agent's ID or name to continue a previously spawned agent with its context intact; a new Agent call starts fresh.\n- Each agent type's model, reasoning effort, and tools come from its definition (`.claude/agents/*.md` frontmatter or SDK `agents`).\n- `isolation: \"worktree\"` gives the agent its own git worktree (auto-cleaned if unchanged).\n- Subagents run in the background by default; you'll be notified when one completes. Pass `run_in_background: false` for a synchronous run when you need the result before continuing. Never fabricate or predict a pending agent's results — the notification is never something you write yourself; if the user asks before it arrives, say it's still running.",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "description": {
          "description": "A short (3-5 word) description of the task",
          "type": "string"
        },
        "prompt": {
          "description": "The task for the agent to perform",
          "type": "string"
        },
        "subagent_type": {
          "description": "The type of specialized agent to use for this task",
          "type": "string"
        },
        "model": {
          "description": "Optional model override for this agent. Takes precedence over the agent definition's model frontmatter. If omitted, uses the agent definition's model, or inherits from the parent. Ignored for subagent_type: \"fork\" — forks always inherit the parent model.",
          "type": "string",
          "enum": [
            "sonnet",
            "opus",
            "haiku",
            "fable"
          ]
        },
        "run_in_background": {
          "description": "Agents run in the background by default; you will be notified when one completes. Set to false to run this agent synchronously when you need its result before continuing.",
          "type": "boolean"
        },
        "name": {
          "description": "Name for the spawned agent. Makes it addressable via SendMessage({to: name}) while running.",
          "type": "string",
          "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
        },
        "team_name": {
          "description": "Deprecated; ignored. The session has a single implicit team.",
          "type": "string"
        },
        "mode": {
          "description": "Deprecated; ignored. Subagents inherit the parent session's permission mode; agent-definition frontmatter may override it.",
          "type": "string",
          "enum": [
            "acceptEdits",
            "auto",
            "bypassPermissions",
            "default",
            "dontAsk",
            "plan"
          ]
        },
        "isolation": {
          "description": "Isolation mode. \"worktree\" creates a temporary git worktree so the agent works on an isolated copy of the repo. \"remote\" launches the agent in a remote cloud environment (always runs in background; availability is gated).",
          "type": "string",
          "enum": [
            "worktree",
            "remote"
          ]
        }
      },
      "required": [
        "description",
        "prompt"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "Bash",
    "description": "Executes a bash command and returns its output.\n\nThis tool runs Git Bash (POSIX sh), not cmd.exe or PowerShell. Use Unix shell syntax: `/dev/null` not `NUL`, forward slashes, `$VAR` not `%VAR%` or `$env:VAR`. Do not use PowerShell here-strings (`@'…'@`) or backtick continuation here — for multi-line strings use a heredoc.\n\n- Working directory persists between calls, but prefer absolute paths — `cd` in a compound command can trigger a permission prompt. Shell state (env vars, functions) does not persist; the shell is initialized from the user's profile.\n- IMPORTANT: Avoid using this tool to run `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user.\n- `timeout` is in milliseconds: default 120000, max 600000.\n- `run_in_background` runs the command detached: it keeps running across turns and re-invokes you when it exits. No `&` needed.",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "command": {
          "description": "The command to execute",
          "type": "string"
        },
        "timeout": {
          "description": "Optional timeout in milliseconds (max 600000)",
          "type": "number"
        },
        "description": {
          "description": "Clear, concise description of what this command does in active voice. Never use words like \"complex\" or \"risk\" in the description - just describe what it does.\n\nFor simple commands (git, npm, standard CLI tools), keep it brief (5-10 words):\n- ls → \"List files in current directory\"\n- git status → \"Show working tree status\"\n- npm install → \"Install package dependencies\"\n\nFor commands that are harder to parse at a glance (piped commands, obscure flags, etc.), add enough context to clarify what it does:\n- find . -name \"*.tmp\" -exec rm {} \\; → \"Find and delete all .tmp files recursively\"\n- git reset --hard origin/main → \"Discard all local changes and match remote main\"\n- curl -s url | jq '.data[]' → \"Fetch JSON from URL and extract data array elements\"",
          "type": "string"
        },
        "run_in_background": {
          "description": "Set to true to run this command in the background.",
          "type": "boolean"
        },
        "dangerouslyDisableSandbox": {
          "description": "Set this to true to dangerously override sandbox mode and run commands without sandboxing.",
          "type": "boolean"
        }
      },
      "required": [
        "command"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "CronCreate",
    "description": "Schedule a prompt to be enqueued at a future time. Use for both recurring schedules and one-shot reminders.\n\nUses standard 5-field cron in the user's local timezone: minute hour day-of-month month day-of-week. \"0 9 * * *\" means 9am local — no timezone conversion needed.\n\n## One-shot tasks (recurring: false)\n\nFor \"remind me at X\" or \"at <time>, do Y\" requests — fire once then auto-delete.\nPin minute/hour/day-of-month/month to specific values:\n  \"remind me at 2:30pm today to check the deploy\" → cron: \"30 14 <today_dom> <today_month> *\", recurring: false\n  \"tomorrow morning, run the smoke test\" → cron: \"57 8 <tomorrow_dom> <tomorrow_month> *\", recurring: false\n\n## Recurring jobs (recurring: true, the default)\n\nFor \"every N minutes\" / \"every hour\" / \"weekdays at 9am\" requests:\n  \"*/5 * * * *\" (every 5 min), \"0 * * * *\" (hourly), \"0 9 * * 1-5\" (weekdays at 9am local)\n\n## Avoid the :00 and :30 minute marks when the task allows it\n\nEvery user who asks for \"9am\" gets `0 9`, and every user who asks for \"hourly\" gets `0 *` — which means requests from across the planet land on the API at the same instant. When the user's request is approximate, pick a minute that is NOT 0 or 30:\n  \"every morning around 9\" → \"57 8 * * *\" or \"3 9 * * *\" (not \"0 9 * * *\")\n  \"hourly\" → \"7 * * * *\" (not \"0 * * * *\")\n  \"in an hour or so, remind me to...\" → pick whatever minute you land on, don't round\n\nOnly use minute 0 or 30 when the user names that exact time and clearly means it (\"at 9:00 sharp\", \"at half past\", coordinating with a meeting). When in doubt, nudge a few minutes early or late — the user will not notice, and the fleet will.\n\n## Durability\n\nBy default (durable: false) the job lives only in this Claude session — nothing is written to disk, and the job is gone when Claude exits. Pass durable: true to write to .claude/scheduled_tasks.json so the job survives restarts. Only use durable: true when the user explicitly asks for the task to persist (\"keep doing this every day\", \"set this up permanently\"). Most \"remind me in 5 minutes\" / \"check back in an hour\" requests should stay session-only.\n\n## Runtime behavior\n\nJobs only fire while the REPL is idle (not mid-query). Durable jobs persist to .claude/scheduled_tasks.json and survive session restarts — on next launch they resume automatically. One-shot durable tasks that were missed while the REPL was closed are surfaced for catch-up. Session-only jobs die with the process. The scheduler adds a small deterministic jitter on top of whatever you pick: recurring tasks fire up to 10% of their period late (max 15 min); one-shot tasks landing on :00 or :30 fire up to 90 s early. Picking an off-minute is still the bigger lever.\n\nRecurring tasks auto-expire after 7 days — they fire one final time, then are deleted. This bounds session lifetime. Tell the user about the 7-day limit when scheduling recurring jobs.\n\nReturns a job ID you can pass to CronDelete.",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "cron": {
          "description": "Standard 5-field cron expression in local time: \"M H DoM Mon DoW\" (e.g. \"*/5 * * * *\" = every 5 minutes, \"30 14 28 2 *\" = Feb 28 at 2:30pm local once).",
          "type": "string"
        },
        "prompt": {
          "description": "The prompt to enqueue at each fire time.",
          "type": "string"
        },
        "recurring": {
          "description": "true (default) = fire on every cron match until deleted or auto-expired after 7 days. false = fire once at the next match, then auto-delete. Use false for \"remind me at X\" one-shot requests with pinned minute/hour/dom/month.",
          "type": "boolean"
        },
        "durable": {
          "description": "true = persist to .claude/scheduled_tasks.json and survive restarts. false (default) = in-memory only, dies when this Claude session ends. Use true only when the user asks the task to survive across sessions.",
          "type": "boolean"
        }
      },
      "required": [
        "cron",
        "prompt"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "CronDelete",
    "description": "Cancel a cron job previously scheduled with CronCreate. Removes it from .claude/scheduled_tasks.json (durable jobs) or the in-memory session store (session-only jobs).",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "id": {
          "description": "Job ID returned by CronCreate.",
          "type": "string"
        }
      },
      "required": [
        "id"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "CronList",
    "description": "List all cron jobs scheduled via CronCreate, both durable (.claude/scheduled_tasks.json) and session-only.",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  {
    "name": "Edit",
    "description": "Performs exact string replacement in a file.\n\n- You must Read the file in this conversation before editing, or the call will fail.\n- `old_string` must match the file exactly, including indentation, and be unique — the edit fails otherwise. Strip the Read line prefix (line number + tab) before matching.\n- `replace_all: true` replaces every occurrence instead.",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "file_path": {
          "description": "The absolute path to the file to modify",
          "type": "string"
        },
        "old_string": {
          "description": "The text to replace",
          "type": "string"
        },
        "new_string": {
          "description": "The text to replace it with (must be different from old_string)",
          "type": "string"
        },
        "replace_all": {
          "description": "Replace all occurrences of old_string (default false)",
          "default": false,
          "type": "boolean"
        }
      },
      "required": [
        "file_path",
        "old_string",
        "new_string"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "EnterWorktree",
    "description": "Use this tool ONLY when explicitly instructed to work in a worktree — either by the user directly, or by project instructions (CLAUDE.md / memory). This tool creates an isolated git worktree and switches the current session into it.\n\n## When to Use\n\n- The user explicitly says \"worktree\" (e.g., \"start a worktree\", \"work in a worktree\", \"create a worktree\", \"use a worktree\")\n- CLAUDE.md or memory instructions direct you to work in a worktree for the current task\n\n## When NOT to Use\n\n- The user asks to create a branch, switch branches, or work on a different branch — use git commands instead\n- The user asks to fix a bug or work on a feature — use normal git workflow unless worktrees are explicitly requested by the user or project instructions\n- Never use this tool unless \"worktree\" is explicitly mentioned by the user or in CLAUDE.md / memory instructions\n\n## Requirements\n\n- Must be in a git repository, OR have WorktreeCreate/WorktreeRemove hooks configured in settings.json\n- Must not already be in a worktree session when creating a new worktree (`name`); switching into another existing worktree via `path` is allowed\n\n## Behavior\n\n- In a git repository: creates a new git worktree inside `.claude/worktrees/` on a new branch. The base ref is governed by the `worktree.baseRef` setting: `fresh` (default) branches from origin/<default-branch>; `head` branches from your current local HEAD\n- Outside a git repository: delegates to WorktreeCreate/WorktreeRemove hooks for VCS-agnostic isolation\n- Switches the session's working directory to the new worktree\n- Use ExitWorktree to leave the worktree mid-session (keep or remove). On session exit, if still in the worktree, the user will be prompted to keep or remove it\n\n## Entering an existing worktree\n\nPass `path` instead of `name` to switch the session into a worktree that already exists (e.g., one you just created with `git worktree add`). On first entry from the launch directory, the path must appear in `git worktree list` for the repository that owns it — the current repository or, in a multi-repo workspace, a repository nested inside it; paths registered by neither are rejected. ExitWorktree will not remove a worktree entered this way; use `action: \"keep\"` to return to the original directory.\n\nSwitching with `path` also works when the session is already in a worktree (the previous worktree is left on disk, untouched, and only the new one is tracked for exit-time cleanup), and from agents whose working directory was pinned at launch (subagent isolation or explicit cwd). In both cases the target must be a worktree under `.claude/worktrees/` of the same repository, and from a pinned agent the switch only affects this agent, not the parent session. After a further switch, previously-visited worktrees are no longer writable — re-issue EnterWorktree with `path` to return to one.\n\n## Parameters\n\n- `name` (optional): A name for a new worktree. If neither `name` nor `path` is provided, a random name is generated.\n- `path` (optional): Path to an existing worktree to enter instead of creating one — of the current repository, or (on first entry from the launch directory) of a repository nested inside it. Mutually exclusive with `name`.\n",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "name": {
          "description": "Optional name for a new worktree. Each \"/\"-separated segment may contain only letters, digits, dots, underscores, and dashes; max 64 chars total. A random name is generated if not provided. Mutually exclusive with `path`.",
          "type": "string"
        },
        "path": {
          "description": "Path to an existing worktree to switch into instead of creating a new one. Must appear in `git worktree list` for the current repo — or, on first entry from the launch directory, for a repo nested inside it (multi-repo workspace). Mutually exclusive with `name`.",
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  },
  {
    "name": "ExitWorktree",
    "description": "Exit a worktree session created by EnterWorktree and return the session to the original working directory.\n\n## Scope\n\nThis tool ONLY operates on worktrees created by EnterWorktree in this session. It will NOT touch:\n- Worktrees you created manually with `git worktree add`\n- Worktrees from a previous session (even if created by EnterWorktree then)\n- The directory you're in if EnterWorktree was never called\n\nIf called outside an EnterWorktree session, the tool is a **no-op**: it reports that no worktree session is active and takes no action. Filesystem state is unchanged.\n\n## When to Use\n\n- The user explicitly asks to \"exit the worktree\", \"leave the worktree\", \"go back\", or otherwise end the worktree session\n- Do NOT call this proactively — only when the user asks\n\n## Parameters\n\n- `action` (required): `\"keep\"` or `\"remove\"`\n  - `\"keep\"` — leave the worktree directory and branch intact on disk. Use this if the user wants to come back to the work later, or if there are changes to preserve.\n  - `\"remove\"` — delete the worktree directory and its branch. Use this for a clean exit when the work is done or abandoned.\n- `discard_changes` (optional, default false): only meaningful with `action: \"remove\"`. If the worktree has uncommitted files or commits not on the original branch, the tool will REFUSE to remove it unless this is set to `true`. If the tool returns an error listing changes, confirm with the user before re-invoking with `discard_changes: true`.\n\n## Behavior\n\n- Restores the session's working directory to where it was before EnterWorktree\n- Clears CWD-dependent caches (system prompt sections, memory files, plans directory) so the session state reflects the original directory\n- If a tmux session was attached to the worktree: killed on `remove`, left running on `keep` (its name is returned so the user can reattach)\n- Once exited, EnterWorktree can be called again to create a fresh worktree\n",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "action": {
          "description": "\"keep\" leaves the worktree and branch on disk; \"remove\" deletes both.",
          "type": "string",
          "enum": [
            "keep",
            "remove"
          ]
        },
        "discard_changes": {
          "description": "Required true when action is \"remove\" and the worktree has uncommitted files or unmerged commits. The tool will refuse and list them otherwise.",
          "type": "boolean"
        }
      },
      "required": [
        "action"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "Glob",
    "description": "Fast file pattern matching. Supports glob patterns like \"**/*.js\" or \"src/**/*.ts\". Returns matching file paths sorted by modification time.",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "pattern": {
          "description": "The glob pattern to match files against",
          "type": "string"
        },
        "path": {
          "description": "The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter \"undefined\" or \"null\" - simply omit it for the default behavior. Must be a valid directory path if provided.",
          "type": "string"
        }
      },
      "required": [
        "pattern"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "Grep",
    "description": "Content search built on ripgrep. Prefer this over `grep`/`rg` via Bash — results integrate with the permission UI and file links.\n\n- Full regex syntax (e.g. \"log.*Error\", \"function\\s+\\w+\"). Ripgrep, not grep — escape literal braces (`interface\\{\\}`).\n- Filter with `glob` (e.g. \"**/*.tsx\") or `type` (e.g. \"js\", \"py\", \"rust\").\n- `output_mode`: \"content\" (matching lines), \"files_with_matches\" (paths only, default), or \"count\".\n- `multiline: true` for patterns that span lines.",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "pattern": {
          "description": "The regular expression pattern to search for in file contents",
          "type": "string"
        },
        "path": {
          "description": "File or directory to search in (rg PATH). Defaults to current working directory.",
          "type": "string"
        },
        "glob": {
          "description": "Glob pattern to filter files (e.g. \"*.js\", \"*.{ts,tsx}\") - maps to rg --glob",
          "type": "string"
        },
        "output_mode": {
          "description": "Output mode: \"content\" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), \"files_with_matches\" shows file paths (supports head_limit), \"count\" shows match counts (supports head_limit). Defaults to \"files_with_matches\".",
          "type": "string",
          "enum": [
            "content",
            "files_with_matches",
            "count"
          ]
        },
        "-B": {
          "description": "Number of lines to show before each match (rg -B). Requires output_mode: \"content\", ignored otherwise.",
          "type": "number"
        },
        "-A": {
          "description": "Number of lines to show after each match (rg -A). Requires output_mode: \"content\", ignored otherwise.",
          "type": "number"
        },
        "-C": {
          "description": "Alias for context.",
          "type": "number"
        },
        "context": {
          "description": "Number of lines to show before and after each match (rg -C). Requires output_mode: \"content\", ignored otherwise.",
          "type": "number"
        },
        "-n": {
          "description": "Show line numbers in output (rg -n). Requires output_mode: \"content\", ignored otherwise. Defaults to true.",
          "type": "boolean"
        },
        "-i": {
          "description": "Case insensitive search (rg -i)",
          "type": "boolean"
        },
        "-o": {
          "description": "Print only the matched (non-empty) parts of each matching line, one match per output line (rg -o / --only-matching). Requires output_mode: \"content\", ignored otherwise. Defaults to false.",
          "type": "boolean"
        },
        "type": {
          "description": "File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.",
          "type": "string"
        },
        "head_limit": {
          "description": "Limit output to first N lines/entries, equivalent to \"| head -N\". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults to 250 when unspecified. Pass 0 for unlimited (use sparingly — large result sets waste context).",
          "type": "number"
        },
        "offset": {
          "description": "Skip first N lines/entries before applying head_limit, equivalent to \"| tail -n +N | head -N\". Works across all output modes. Defaults to 0.",
          "type": "number"
        },
        "multiline": {
          "description": "Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.",
          "type": "boolean"
        }
      },
      "required": [
        "pattern"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "NotebookEdit",
    "description": "Replaces, inserts, or deletes a single cell in a Jupyter notebook (.ipynb file).\n\nUsage:\n- You must use the Read tool on the notebook in this conversation before editing — this tool will fail otherwise.\n- `notebook_path` must be an absolute path.\n- `cell_id` is the `id` attribute shown in the Read tool's `<cell id=\"...\">` output. It is required for `replace` and `delete`.\n- `edit_mode` defaults to `replace`. Use `insert` to add a new cell after the cell with the given `cell_id` (or at the beginning of the notebook if `cell_id` is omitted) — `cell_type` is required when inserting. Use `delete` to remove the cell.",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "notebook_path": {
          "description": "The absolute path to the Jupyter notebook file to edit (must be absolute, not relative)",
          "type": "string"
        },
        "cell_id": {
          "description": "The ID of the cell to edit. When inserting a new cell, the new cell will be inserted after the cell with this ID, or at the beginning if not specified.",
          "type": "string"
        },
        "new_source": {
          "description": "The new source for the cell",
          "type": "string"
        },
        "cell_type": {
          "description": "The type of the cell (code or markdown). If not specified, it defaults to the current cell type. If using edit_mode=insert, this is required.",
          "type": "string",
          "enum": [
            "code",
            "markdown"
          ]
        },
        "edit_mode": {
          "description": "The type of edit to make (replace, insert, delete). Defaults to replace.",
          "type": "string",
          "enum": [
            "replace",
            "insert",
            "delete"
          ]
        }
      },
      "required": [
        "notebook_path",
        "new_source"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "PowerShell",
    "description": "Executes a given PowerShell command with optional timeout. Working directory persists between commands; shell state (variables, functions) does not.\n\nIMPORTANT: This tool is for terminal operations via PowerShell: git, npm, docker, and PS cmdlets. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.\n\nPowerShell edition: PowerShell 7+ (pwsh)\n   - Pipeline chain operators `&&` and `||` ARE available and work like bash. Prefer `cmd1 && cmd2` over `cmd1; cmd2` when cmd2 should only run if cmd1 succeeds.\n   - Ternary (`$cond ? $a : $b`), null-coalescing (`??`), and null-conditional (`?.`) operators are available.\n   - Default file encoding is UTF-8 without BOM.\n\nBefore executing the command, please follow these steps:\n\n1. Directory Verification:\n   - If the command will create new directories or files, first use `Get-ChildItem` (or `ls`) to verify the parent directory exists and is the correct location\n\n2. Command Execution:\n   - Always quote file paths that contain spaces with double quotes\n   - Capture the output of the command.\n\nPowerShell Syntax Notes:\n   - Variables use $ prefix: $myVar = \"value\"\n   - Escape character is backtick (`), not backslash\n   - Use Verb-Noun cmdlet naming: Get-ChildItem, Set-Location, New-Item, Remove-Item\n   - Common aliases: ls (Get-ChildItem), cd (Set-Location), cat (Get-Content), rm (Remove-Item)\n   - Pipe operator | works similarly to bash but passes objects, not text\n   - Use Select-Object, Where-Object, ForEach-Object for filtering and transformation\n   - String interpolation: \"Hello $name\" or \"Hello $($obj.Property)\"\n   - Registry access uses PSDrive prefixes: `HKLM:\\SOFTWARE\\...`, `HKCU:\\...` — NOT raw `HKEY_LOCAL_MACHINE\\...`\n   - Environment variables: read with `$env:NAME`, set with `$env:NAME = \"value\"` (NOT `Set-Variable` or bash `export`)\n   - Call native exe with spaces in path via call operator: `& \"C:\\Program Files\\App\\app.exe\" arg1 arg2`\n\nUnix commands that DO NOT exist in PowerShell — use the equivalent instead:\n   - head / tail → `Get-Content file -TotalCount N` / `-Tail N`; piped: `| Select-Object -First N` / `-Last N`\n   - which → `(Get-Command name).Source`\n   - touch → `if (-not (Test-Path path)) { New-Item -ItemType File path }` (NEVER use `New-Item -Force` on a file — it truncates existing content)\n   - wc -l → `(Get-Content file | Measure-Object -Line).Lines`\n   - mkdir -p → `New-Item -ItemType Directory -Force path` (`-p` is not a PowerShell flag)\n   - rm -rf → `Remove-Item -Recurse -Force path`\n   - ln -s → `New-Item -ItemType SymbolicLink -Path link -Target target`\n   - chmod / chown → not applicable on Windows; use `icacls` only if ACL changes are required\n   - 2>/dev/null → `2>$null` (but stderr is captured for you — usually unnecessary)\n   - VAR=x cmd → `$env:VAR = 'x'; cmd` (PowerShell has no inline env-var prefix)\n   - Bash control flow (`if [ -f x ]`, `for x in *`, backtick ``cmd`` substitution) is a parser error — use `if (Test-Path x)`, `foreach ($x in ...)`, `$(cmd)`\n\nExit-code note: `-ErrorAction SilentlyContinue` suppresses error OUTPUT but the cmdlet failure still causes this tool to report exit 1. To make a cmdlet failure truly non-fatal, promote it to terminating and swallow it: `try { Cmdlet ... -ErrorAction Stop } catch {}` (without `-ErrorAction Stop`, non-terminating errors skip the `catch` and still exit 1).\n\nInteractive and blocking commands (this tool runs with -NonInteractive and stdin attached to the null device — console prompts read EOF or error immediately; GUI prompts can still block until timeout):\n   - NEVER use `Read-Host`, `Get-Credential`, `Out-GridView`, `$Host.UI.PromptForChoice`, or `pause`\n   - Destructive cmdlets (`Remove-Item`, `Stop-Process`, `Clear-Content`, etc.) may prompt for confirmation. Add `-Confirm:$false` when you intend the action to proceed. Use `-Force` for read-only/hidden items.\n   - Never use `git rebase -i`, `git add -i`, or other commands that open an interactive editor\n\nPassing multiline strings (commit messages, file content) to native executables:\n   - Use a single-quoted here-string so PowerShell does not expand `$` or backticks inside. The closing `'@` MUST be at column 0 (no leading whitespace) on its own line — indenting it is a parse error:\n<example>\ngit commit -m @'\nCommit message here.\nSecond line with $literal dollar signs.\n'@\n</example>\n   - Use `@'...'@` (single-quoted, literal) not `@\"...\"@` (double-quoted, interpolated) unless you need variable expansion\n   - For arguments containing `-`, `@`, or other characters PowerShell parses as operators, use the stop-parsing token: `git log --% --format=%H`\n\nUsage notes:\n  - The command argument is required.\n  - You can specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). If not specified, commands will timeout after 120000ms (2 minutes).\n  - It is very helpful if you write a clear, concise description of what this command does.\n  - If the output exceeds 30000 characters, output will be truncated before being returned to you.\n  - You can use the `run_in_background` parameter to run the command in the background. Only use this if you don't need the result immediately and are OK being notified when the command completes later. You do not need to check the output right away - you'll be notified when it finishes.\n  - Avoid using PowerShell to run commands that have dedicated tools, unless explicitly instructed:\n    - File search: Use Glob (NOT Get-ChildItem -Recurse)\n    - Content search: Use Grep (NOT Select-String)\n    - Read files: Use Read (NOT Get-Content)\n    - Edit files: Use Edit\n    - Write files: Use Write (NOT Set-Content/Out-File)\n    - Communication: Output text directly (NOT Write-Output/Write-Host)\n  - When issuing multiple commands:\n    - If the commands are independent and can run in parallel, make multiple PowerShell tool calls in a single message.\n    - If the commands depend on each other and must run sequentially, chain them in a single PowerShell call (see edition-specific chaining syntax above).\n    - Use `;` only when you need to run commands sequentially but don't care if earlier commands fail.\n    - DO NOT use newlines to separate commands (newlines are ok in quoted strings and here-strings)\n  - Do NOT prefix commands with `cd` or `Set-Location` -- the working directory is already set to the correct project directory automatically.\n  - Avoid unnecessary `Start-Sleep` commands:\n    - Do not sleep between commands that can run immediately — just run them.\n    - If your command is long running and you would like to be notified when it finishes — simply run your command using `run_in_background`. There is no need to sleep in this case.\n    - Do not retry failing commands in a sleep loop — diagnose the root cause or consider an alternative approach.\n    - If waiting for a background task you started with `run_in_background`, you will be notified when it completes — do not poll.\n    - If you must poll an external process, use a check command rather than sleeping first.\n    - If you must sleep, keep the duration short to avoid blocking the user.\n  - For git commands:\n    - Prefer to create a new commit rather than amending an existing commit.\n    - Before running destructive operations (e.g., git reset --hard, git push --force, git checkout --), consider whether there is a safer alternative that achieves the same goal. Only use destructive operations when they are truly the best approach.\n    - Never skip hooks (--no-verify) or bypass signing (--no-gpg-sign, -c commit.gpgsign=false) unless the user has explicitly asked for it. If a hook fails, investigate and fix the underlying issue.",
    "input_schema": {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "type": "object",
      "properties": {
        "command": {
          "description": "The PowerShell command to execute",
          "type": "string"
        },
        "timeout": {
          "description": "Optional timeout in milliseconds (max 600000)",
          "type": "number"
        },
        "description": {
          "description": "Clear, concise description of what this command does in active voice.",
          "type": "string"
        },
        "run_in_background": {
          "description": "Set to true to run this command in the background.",
          "type": "boolean"
        },
        "dangerouslyDisableSandbox": {
          "description": "Set this to true to dangerously override sandbox mode and run commands without sandboxing.",
          "type": "boolean"
        }
      },
      "required": [
        "command"
      ],
      "additionalProperties": false
    }
  }
];
