#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const exec = promisify(execFile);

const server = new McpServer({
  name: "runpod-dx",
  version: "0.1.0",
});

// ── Tool 1: scaffold-worker ──────────────────────────────────────────

server.tool(
  "scaffold-worker",
  "Generate a complete RunPod Serverless worker project: handler.py, Dockerfile, requirements.txt, test_input.json, and .gitignore. Ready to test locally and deploy.",
  {
    directory: z.string().describe("Absolute path to create the project in"),
    task: z.enum(["text-classification", "image-classification", "text-generation", "embedding", "custom"]).describe("ML task type — determines the handler template"),
    model: z.string().optional().describe("HuggingFace model ID (e.g. 'distilbert/distilbert-base-uncased-finetuned-sst-2-english')"),
    description: z.string().optional().describe("What this worker does, used in the handler docstring"),
  },
  async ({ directory, task, model, description }) => {
    const templates = getTemplates(task, model, description);

    await fs.mkdir(directory, { recursive: true });

    const files = {
      "handler.py": templates.handler,
      "Dockerfile": templates.dockerfile,
      "requirements.txt": templates.requirements,
      "test_input.json": templates.testInput,
      ".gitignore": ".venv/\n__pycache__/\n*.pyc\n",
    };

    const created = [];
    for (const [name, content] of Object.entries(files)) {
      const filePath = path.join(directory, name);
      const exists = await fs.access(filePath).then(() => true).catch(() => false);
      if (exists) {
        created.push(`SKIPPED ${name} (already exists)`);
      } else {
        await fs.writeFile(filePath, content);
        created.push(`CREATED ${name}`);
      }
    }

    return {
      content: [{
        type: "text",
        text: [
          `Scaffolded ${task} worker in ${directory}`,
          "",
          ...created,
          "",
          "Next steps:",
          "  python3 -m venv .venv && source .venv/bin/activate",
          "  pip install -r requirements.txt",
          "  python handler.py              # SDK auto-detects test_input.json",
          "",
          "  docker build --platform=linux/amd64 -t youruser/worker:v1 .",
          "  docker push youruser/worker:v1",
        ].join("\n"),
      }],
    };
  }
);

// ── Tool 2: test-handler ─────────────────────────────────────────────

server.tool(
  "test-handler",
  "Run a RunPod handler locally using the SDK's built-in test mode. Returns the handler's structured output or the error. No GPU or account balance required.",
  {
    handler_path: z.string().describe("Absolute path to handler.py"),
    input: z.record(z.unknown()).describe("The job input payload (what goes inside {\"input\": {...}})"),
    python: z.string().optional().describe("Python binary path (default: looks for .venv/bin/python, then python3)"),
    timeout: z.number().optional().describe("Timeout in seconds (default: 120)"),
  },
  async ({ handler_path, input, python, timeout }) => {
    const dir = path.dirname(handler_path);
    const venvPython = path.join(dir, ".venv", "bin", "python");
    const hasVenv = await fs.access(venvPython).then(() => true).catch(() => false);
    const py = python || (hasVenv ? venvPython : "python3");

    const testPayload = JSON.stringify({ input });
    const timeoutMs = (timeout || 120) * 1000;

    try {
      const { stdout, stderr } = await exec(
        py,
        [handler_path, "--test_input", testPayload],
        { cwd: dir, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }
      );

      const jobResult = extractJobResult(stdout + stderr);

      return {
        content: [{
          type: "text",
          text: [
            "✓ Handler test PASSED",
            "",
            jobResult ? `Result: ${jobResult}` : `Full output:\n${(stdout + stderr).slice(-2000)}`,
          ].join("\n"),
        }],
      };
    } catch (err) {
      return {
        content: [{
          type: "text",
          text: [
            "✗ Handler test FAILED",
            "",
            `Exit code: ${err.code || "unknown"}`,
            "",
            `stderr:\n${(err.stderr || "").slice(-2000)}`,
            "",
            `stdout:\n${(err.stdout || "").slice(-1000)}`,
          ].join("\n"),
        }],
        isError: true,
      };
    }
  }
);

// ── Tool 3: lint-handler ─────────────────────────────────────────────

server.tool(
  "lint-handler",
  "Check a RunPod handler and Dockerfile for common mistakes: model loading inside the handler (should be module-level), missing platform flag, unpinned versions, missing error handling, payload limit risks.",
  {
    directory: z.string().describe("Absolute path to the worker project directory"),
  },
  async ({ directory }) => {
    const findings = [];

    // Check handler.py
    const handlerPath = path.join(directory, "handler.py");
    try {
      const handler = await fs.readFile(handlerPath, "utf-8");

      if (!handler.includes("runpod.serverless.start")) {
        findings.push({ severity: "error", file: "handler.py", message: "Missing runpod.serverless.start() — the SDK won't serve jobs without it" });
      }

      const handlerMatch = handler.match(/def handler\s*\([^)]*\)[\s\S]*?(?=\ndef |\nrunpod|\n[A-Z]|\Z)/);
      if (handlerMatch) {
        const body = handlerMatch[0];
        if (body.includes("pipeline(") || body.includes("from_pretrained(") || body.includes("AutoModel")) {
          findings.push({ severity: "warning", file: "handler.py", message: "Model loading detected INSIDE the handler function — this runs on every request. Move it to module level so it loads once per worker cold start." });
        }
      }

      if (!handler.includes('job["input"]') && !handler.includes("job['input']") && !handler.includes('job.get("input")')) {
        findings.push({ severity: "warning", file: "handler.py", message: "Handler doesn't read job[\"input\"] — the request payload lives under the 'input' key" });
      }

      if (!handler.includes("raise") && !handler.includes("ValueError") && !handler.includes("KeyError")) {
        findings.push({ severity: "info", file: "handler.py", message: "No explicit error handling — uncaught exceptions mark the job FAILED with a generic message. Consider validating required fields." });
      }

      const importLines = handler.split("\n").filter(l => l.match(/^(import |from )/));
      if (importLines.some(l => l.includes("torch")) && !handler.includes("torch.no_grad")) {
        findings.push({ severity: "info", file: "handler.py", message: "Using torch without torch.no_grad() context — inference handlers should wrap forward passes in no_grad for memory efficiency" });
      }
    } catch {
      findings.push({ severity: "error", file: "handler.py", message: "handler.py not found in project directory" });
    }

    // Check Dockerfile
    const dockerfilePath = path.join(directory, "Dockerfile");
    try {
      const dockerfile = await fs.readFile(dockerfilePath, "utf-8");

      if (!dockerfile.includes("linux/amd64") && !dockerfile.includes("--platform")) {
        findings.push({ severity: "error", file: "Dockerfile", message: "Missing --platform=linux/amd64 — RunPod hosts are x86_64. Images built on ARM (Apple Silicon) will fail silently." });
      }

      if (dockerfile.includes(":latest") && !dockerfile.includes("# pinned")) {
        findings.push({ severity: "warning", file: "Dockerfile", message: "Using :latest tag — RunPod caches images per host, so a stale 'latest' can silently run old code. Pin to a version tag." });
      }

      if (!dockerfile.includes("-u") || !dockerfile.match(/CMD.*-u/)) {
        findings.push({ severity: "info", file: "Dockerfile", message: "CMD missing python -u flag — without unbuffered output, worker logs may be delayed or empty in the RunPod console" });
      }
    } catch {
      findings.push({ severity: "info", file: "Dockerfile", message: "No Dockerfile found — needed for deploy (not for local testing)" });
    }

    // Check requirements.txt
    const reqsPath = path.join(directory, "requirements.txt");
    try {
      const reqs = await fs.readFile(reqsPath, "utf-8");

      if (!reqs.includes("runpod")) {
        findings.push({ severity: "error", file: "requirements.txt", message: "Missing 'runpod' SDK dependency" });
      }

      const unpinned = reqs.split("\n").filter(l => l.trim() && !l.startsWith("#") && !l.match(/[=~<>!]/));
      if (unpinned.length > 0) {
        findings.push({ severity: "warning", file: "requirements.txt", message: `Unpinned dependencies: ${unpinned.join(", ")} — version drift between builds can break workers silently` });
      }

      if (reqs.includes("torch") && reqs.includes("numpy") && !reqs.match(/numpy\s*<\s*2/)) {
        findings.push({ severity: "warning", file: "requirements.txt", message: "torch + numpy without numpy<2 pin — older torch wheels crash at inference with NumPy 2.x ('Numpy is not available')" });
      }
    } catch {
      findings.push({ severity: "info", file: "requirements.txt", message: "No requirements.txt found" });
    }

    const errors = findings.filter(f => f.severity === "error").length;
    const warnings = findings.filter(f => f.severity === "warning").length;

    return {
      content: [{
        type: "text",
        text: [
          `Lint: ${errors} error(s), ${warnings} warning(s), ${findings.length - errors - warnings} info`,
          "",
          ...findings.map(f => `[${f.severity.toUpperCase()}] ${f.file}: ${f.message}`),
          "",
          findings.length === 0 ? "✓ No issues found — handler looks ready to deploy." : "",
        ].join("\n"),
      }],
    };
  }
);

// ── Tool 4: estimate-cost ────────────────────────────────────────────

server.tool(
  "estimate-cost",
  "Estimate RunPod Serverless costs for an endpoint configuration. Uses the GPU catalog pricing to project hourly, daily, and monthly costs based on expected usage patterns.",
  {
    gpu_id: z.string().describe("GPU pool ID from RunPod catalog (e.g. 'AMPERE_24', 'ADA_80_PRO')"),
    price_per_hour: z.number().describe("Serverless $/hr rate for this GPU (from list-gpu-types)"),
    avg_job_seconds: z.number().describe("Average job duration in seconds"),
    jobs_per_day: z.number().describe("Expected number of jobs per day"),
    workers_min: z.number().default(0).describe("Minimum active workers (0 = scale to zero)"),
  },
  async ({ gpu_id, price_per_hour, avg_job_seconds, jobs_per_day, workers_min }) => {
    const perSecond = price_per_hour / 3600;
    const jobCost = perSecond * avg_job_seconds;
    const dailyJobCost = jobCost * jobs_per_day;
    const dailyActiveSeconds = avg_job_seconds * jobs_per_day;
    const dailyActiveHours = dailyActiveSeconds / 3600;

    const standingCostDaily = workers_min * price_per_hour * 24;
    const standingCostMonthly = standingCostDaily * 30;

    const totalDaily = dailyJobCost + standingCostDaily;
    const totalMonthly = totalDaily * 30;

    const lines = [
      `Cost estimate for ${gpu_id} @ $${price_per_hour.toFixed(2)}/hr`,
      "",
      "Per job:",
      `  Duration: ${avg_job_seconds}s → $${jobCost.toFixed(4)}/job`,
      "",
      "Daily usage:",
      `  ${jobs_per_day} jobs × ${avg_job_seconds}s = ${dailyActiveHours.toFixed(2)} active hours`,
      `  Job compute: $${dailyJobCost.toFixed(2)}/day`,
    ];

    if (workers_min > 0) {
      lines.push(
        `  Standing workers (${workers_min}): $${standingCostDaily.toFixed(2)}/day`,
        `  ⚠ Standing workers bill 24/7 even with no jobs`,
      );
    } else {
      lines.push("  Standing workers: $0.00 (scale to zero)");
    }

    lines.push(
      "",
      "Monthly projection:",
      `  Job compute: $${(dailyJobCost * 30).toFixed(2)}`,
      `  Standing:    $${standingCostMonthly.toFixed(2)}`,
      `  Total:       $${totalMonthly.toFixed(2)}/month`,
      "",
      workers_min === 0
        ? "💡 Scale-to-zero means $0 when idle. First request after idle has a cold start (model load + container pull)."
        : `💡 ${workers_min} standing worker(s) = instant response but $${standingCostMonthly.toFixed(2)}/mo floor even with no traffic.`,
    );

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ── Tool 5: doctor ───────────────────────────────────────────────────

server.tool(
  "doctor",
  "Pre-deploy checklist: verifies local environment is ready to build and deploy a RunPod Serverless worker. Checks Python, Docker, runpodctl, SDK version, and image architecture.",
  {
    directory: z.string().optional().describe("Project directory to check (optional — also runs global checks)"),
  },
  async ({ directory }) => {
    const checks = [];

    // Python
    try {
      const { stdout } = await exec("python3", ["--version"]);
      checks.push({ name: "Python 3", status: "ok", detail: stdout.trim() });
    } catch {
      checks.push({ name: "Python 3", status: "fail", detail: "python3 not found" });
    }

    // Docker
    try {
      const { stdout } = await exec("docker", ["--version"]);
      checks.push({ name: "Docker", status: "ok", detail: stdout.trim() });

      try {
        const { stdout: infoOut } = await exec("docker", ["info", "--format", "{{.OSType}}/{{.Architecture}}"]);
        checks.push({ name: "Docker platform", status: "ok", detail: infoOut.trim() });
      } catch {
        checks.push({ name: "Docker daemon", status: "warn", detail: "Docker installed but daemon not running — start Docker Desktop to build images" });
      }
    } catch {
      checks.push({ name: "Docker", status: "fail", detail: "Docker not found — install from docker.com" });
    }

    // runpodctl
    try {
      const { stdout } = await exec("runpodctl", ["version"]);
      checks.push({ name: "runpodctl", status: "ok", detail: stdout.trim() });
    } catch {
      const localBin = path.join(process.env.HOME || "", ".local", "bin", "runpodctl");
      try {
        const { stdout } = await exec(localBin, ["version"]);
        checks.push({ name: "runpodctl", status: "ok", detail: `${stdout.trim()} (at ${localBin})` });
      } catch {
        checks.push({ name: "runpodctl", status: "warn", detail: "Not found — install from https://docs.runpod.io/cli/install" });
      }
    }

    // RunPod Python SDK
    try {
      const { stdout } = await exec("python3", ["-c", "import runpod; print(runpod.__version__)"]);
      checks.push({ name: "RunPod SDK", status: "ok", detail: `v${stdout.trim()}` });
    } catch {
      checks.push({ name: "RunPod SDK", status: "warn", detail: "Not installed globally — check project venv" });
    }

    // Project-specific checks
    if (directory) {
      const handlerExists = await fs.access(path.join(directory, "handler.py")).then(() => true).catch(() => false);
      checks.push({ name: "handler.py", status: handlerExists ? "ok" : "fail", detail: handlerExists ? "Found" : "Missing" });

      const dockerfileExists = await fs.access(path.join(directory, "Dockerfile")).then(() => true).catch(() => false);
      checks.push({ name: "Dockerfile", status: dockerfileExists ? "ok" : "fail", detail: dockerfileExists ? "Found" : "Missing — needed for deploy" });

      const venvExists = await fs.access(path.join(directory, ".venv", "bin", "python")).then(() => true).catch(() => false);
      checks.push({ name: "Virtual env", status: venvExists ? "ok" : "warn", detail: venvExists ? ".venv found" : "No .venv — run: python3 -m venv .venv" });

      if (venvExists) {
        try {
          const py = path.join(directory, ".venv", "bin", "python");
          const { stdout } = await exec(py, ["-c", "import runpod; print(runpod.__version__)"]);
          checks.push({ name: "SDK in venv", status: "ok", detail: `v${stdout.trim()}` });
        } catch {
          checks.push({ name: "SDK in venv", status: "fail", detail: "runpod not installed in venv" });
        }
      }
    }

    const ok = checks.filter(c => c.status === "ok").length;
    const fail = checks.filter(c => c.status === "fail").length;

    return {
      content: [{
        type: "text",
        text: [
          `Doctor: ${ok} pass, ${fail} fail, ${checks.length - ok - fail} warn`,
          "",
          ...checks.map(c => {
            const icon = c.status === "ok" ? "✓" : c.status === "fail" ? "✗" : "⚠";
            return `${icon} ${c.name}: ${c.detail}`;
          }),
          "",
          fail === 0 ? "Ready to build and deploy." : "Fix the failures above before deploying.",
        ].join("\n"),
      }],
    };
  }
);

// ── Handler templates ────────────────────────────────────────────────

const HF_REPO_RE = /^[A-Za-z0-9][\w.-]*(\/[\w.-]+)?$/;

function sanitizeDescription(raw) {
  return raw
    .replace(/\\/g, "\\\\")
    .replace(/"""/g, "'''")
    .replace(/\n/g, " ")
    .replace(/\r/g, "")
    .slice(0, 200);
}

function getTemplates(task, model, description) {
  const desc = sanitizeDescription(description || `RunPod Serverless worker for ${task}`);
  const rawModel = model || getDefaultModel(task);
  if (rawModel && !HF_REPO_RE.test(rawModel)) {
    throw new Error(`Invalid model ID: ${JSON.stringify(rawModel)} — must be a HuggingFace repo id like 'org/model-name'`);
  }
  const modelId = rawModel;

  const pipelineTask = {
    "text-classification": "text-classification",
    "image-classification": "image-classification",
    "text-generation": "text-generation",
    "embedding": "feature-extraction",
    "custom": null,
  }[task];

  let handler;
  if (task === "custom") {
    handler = `"""${desc}"""

import runpod


def handler(job):
    job_input = job["input"]

    # Your logic here
    result = job_input

    return result


runpod.serverless.start({"handler": handler})
`;
  } else if (task === "embedding") {
    handler = `"""${desc}"""

import runpod
from transformers import AutoTokenizer, AutoModel
import torch

TOKENIZER = AutoTokenizer.from_pretrained("${modelId}")
MODEL = AutoModel.from_pretrained("${modelId}")


def handler(job):
    job_input = job["input"]
    text = job_input.get("text")
    if not text:
        raise ValueError("Missing required field: 'text'")

    inputs = TOKENIZER(text, return_tensors="pt", truncation=True, max_length=512)
    with torch.no_grad():
        outputs = MODEL(**inputs)

    embedding = outputs.last_hidden_state.mean(dim=1).squeeze().tolist()

    return {"embedding": embedding, "dimensions": len(embedding)}


runpod.serverless.start({"handler": handler})
`;
  } else {
    handler = `"""${desc}"""

import runpod
from transformers import pipeline

MODEL = pipeline("${pipelineTask}", model="${modelId}")


def handler(job):
    job_input = job["input"]
    text = job_input.get("text")
    if not text:
        raise ValueError("Missing required field: 'text'")

    results = MODEL(text[:512])

    return {"results": results, "input_length": len(text)}


runpod.serverless.start({"handler": handler})
`;
  }

  const requirements = task === "custom"
    ? "runpod~=1.7.6\n"
    : "runpod~=1.7.6\ntransformers>=4.30.0\ntorch>=2.0.0\n";

  const testInput = task === "custom"
    ? '{\n  "input": {\n    "key": "value"\n  }\n}\n'
    : '{\n  "input": {\n    "text": "This is a test input for the RunPod worker."\n  }\n}\n';

  const dockerfile = `FROM python:3.11.1-slim

WORKDIR /

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
${task !== "custom" ? `
# Pre-download model into the image for fast cold starts
RUN python -c "from transformers import pipeline; pipeline('${pipelineTask}', model='${modelId}')"
` : ""}
COPY handler.py .

CMD ["python", "-u", "/handler.py"]
`;

  return { handler, dockerfile, requirements, testInput };
}

function getDefaultModel(task) {
  return {
    "text-classification": "distilbert/distilbert-base-uncased-finetuned-sst-2-english",
    "image-classification": "google/vit-base-patch16-224",
    "text-generation": "gpt2",
    "embedding": "sentence-transformers/all-MiniLM-L6-v2",
    "custom": "",
  }[task] || "";
}

function extractJobResult(output) {
  const match = output.match(/Job result: ({.*})/s);
  if (match) {
    try {
      return JSON.stringify(JSON.parse(match[1]), null, 2);
    } catch { /* fall through */ }
  }
  const handlerMatch = output.match(/Handler output: ({.*})/s);
  if (handlerMatch) {
    try {
      return JSON.stringify(JSON.parse(handlerMatch[1].replace(/'/g, '"')), null, 2);
    } catch { /* fall through */ }
  }
  return null;
}

// ── Start ────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
