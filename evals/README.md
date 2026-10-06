# Evals

## Task evals (`run-task-evals.mjs`)

These check whether an agent finishes real AutoHotkey tasks better **with** this
MCP server than **without** it. That answers the question that matters: which
tools earn their place in the tool list.

Each task in `tasks/<id>/` is a small AutoHotkey project and a `task.json` file
holding the prompt and its assertions. For each task and mode, the runner:

1. copies the fixture to a temp directory;
2. runs Claude Code headless there with `claude -p`, either with this server
   (`mcp`, only the `--toolsets` you pick) or with no MCP servers (`baseline`);
3. grades the result.

The agent may use Read, Edit, Write, Glob and Grep, plus the server's tools in
`mcp` mode. Bash is denied, so a run cannot reach outside its temp directory
except through the tools under test.

| Task                  | What it exercises                                                              |
| :-------------------- | :----------------------------------------------------------------------------- |
| `fix-v1-syntax`       | Converting v1 commands and assignments to v2                                   |
| `fix-misspelled-call` | Finding the intended function in an `#Include`d file                           |
| `rename-method`       | Renaming a method across three files, leaving `LoadReport` alone               |
| `add-hotkey`          | Adding hotkeys to a GUI script without breaking it                             |
| `locate-definition`   | Answering where a function is defined; a comment mentions it earlier as a trap |

```bash
npm run build
npm run eval:tasks -- --dry-run                          # print the commands, spend nothing
npm run eval:tasks                                       # every task, baseline and mcp, once each
npm run eval:tasks -- --task rename-method --runs 3 --mode mcp --toolsets core,legacy
```

| Option       | Default     | Meaning                                                               |
| :----------- | :---------- | :-------------------------------------------------------------------- |
| `--mode`     | `both`      | `mcp`, `baseline` or `both`                                           |
| `--task`     | all         | Task id; repeat it to run several                                     |
| `--runs`     | `1`         | Runs per task and mode; agents vary, so use 3 or more for comparisons |
| `--model`    | CLI default | Passed to `claude --model`                                            |
| `--toolsets` | `core`      | `AHK_MCP_TOOLSETS` for the server in `mcp` mode                       |
| `--budget`   | `1.00`      | `--max-budget-usd` for each run                                       |
| `--keep`     | off         | Keep each run's temp directory for inspection                         |

The runner prints pass rate, average turns, tool calls, input tokens and total
cost for each mode. It also writes every run to `results/<timestamp>.json`,
which is gitignored. Runs cost API credits and need an authenticated `claude`
CLI. On Windows, set `CLAUDE_BIN` if `claude` is not found on `PATH`.

### Assertions

| Assertion                                                | Passes when                                                                                                     |
| :------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------- |
| `{ "file": "main.ahk", "match": "regex", "flags": "m" }` | The file matches the regex                                                                                      |
| `{ "file": "main.ahk", "notMatch": "regex" }`            | The file does not match the regex                                                                               |
| `{ "file": "lib/x.ahk", "unchanged": true }`             | The file equals its fixture, ignoring line endings                                                              |
| `{ "answer": "regex" }`                                  | The agent's final answer matches the regex                                                                      |
| `{ "check": "main.ahk" }`                                | `AHK_Check` reports no errors. It uses the interpreter when AutoHotkey is installed and static checks otherwise |

Add `"why"` to an assertion to make its failure message readable. Before relying
on a new task, make sure the untouched fixture fails and a correct solution
passes. `npm run test:evals` tests the grader itself.

## Tool-call evals (`mcp-jam-tests.json`, `saved-requests.json`)

These older files send fixed arguments to single tools and check the response
text. Many of them target tools that are now in the `legacy` toolset, such as
`AHK_Diagnostics` and `AHK_Analyze`. Run the server with `AHK_MCP_TOOLSETS=all`
to use them.
