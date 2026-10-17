# runpod-dx-mcp

An MCP server that adds the local developer experience layer RunPod's official MCP is missing.

RunPod's MCP server is excellent for infrastructure management — creating pods, deploying endpoints, managing billing. But the moment you need to *develop* a Serverless worker, you drop into CLI land. This server bridges that gap.

## What it adds

| Tool | What it does |
|------|-------------|
| `scaffold-worker` | Generates handler.py + Dockerfile + requirements.txt + test_input.json from a task type and model name |
| `test-handler` | Runs a handler locally using the SDK's built-in test mode — no GPU, no account balance |
| `lint-handler` | Checks for common mistakes: model loading inside the handler, missing platform flag, unpinned deps, numpy 2.x conflict |
| `estimate-cost` | Cross-references GPU pricing with endpoint config to project hourly/monthly costs |
| `doctor` | Pre-deploy checklist: Python, Docker, runpodctl, SDK version, project files |

## Why these five tools

Each one fills a gap found by actually building a RunPod worker from scratch:

- **scaffold-worker** — the official quickstart is a docs page, not a tool. This generates a tested, deployable project in one call.
- **test-handler** — the SDK has `--test_input` but the MCP doesn't know about it. Now an agent can write a handler, test it, read the output, and iterate — all without leaving the MCP context.
- **lint-handler** — the `--platform=linux/amd64` gotcha, the module-level loading pattern, and the numpy 2.x conflict are all documented in RunPod's guides but only caught *after* a failed deploy. The linter catches them before.
- **estimate-cost** — the GPU catalog has pricing, the endpoint config has scaling params, but nothing combines them into "this will cost $X/month." Now it does.
- **doctor** — `runpodctl doctor` exists but only checks the CLI. This checks the full stack including the project's venv and SDK version.

## Install

```bash
# As a Claude Code MCP server
claude mcp add runpod-dx -- node /path/to/runpod-dx-mcp/src/index.js

# Or via npx (once published)
claude mcp add runpod-dx -- npx runpod-dx-mcp
```

## Companion to, not replacement for

This runs alongside RunPod's official MCP server. Use theirs for infra (create pods, deploy endpoints, manage billing). Use this for dev (scaffold, test, lint, estimate, check).

## Built with

- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) — official MCP TypeScript SDK
- [runpod](https://pypi.org/project/runpod/) — RunPod's Python SDK (used by test-handler for local execution)
