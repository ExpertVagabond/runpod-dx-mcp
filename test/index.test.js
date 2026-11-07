import test from "node:test";
import assert from "node:assert/strict";

import {
  extractJobResult,
  getDefaultModel,
  getTemplates,
  sanitizeDescription,
} from "../src/index.js";

test("sanitizeDescription neutralizes docstring termination and newlines", () => {
  const value = sanitizeDescription('first\nsecond """ third \\ path');
  assert.equal(value, "first second ''' third \\\\ path");
});

test("sanitizeDescription limits generated comments to 200 characters", () => {
  assert.equal(sanitizeDescription("a".repeat(250)).length, 200);
});

test("getTemplates creates a custom worker without model dependencies", () => {
  const templates = getTemplates("custom", undefined, "Echo worker");
  assert.match(templates.handler, /Echo worker/);
  assert.match(templates.handler, /runpod\.serverless\.start/);
  assert.equal(templates.requirements, "runpod~=1.7.6\n");
  assert.doesNotMatch(templates.dockerfile, /transformers/);
});

test("getTemplates rejects malformed model identifiers", () => {
  assert.throws(
    () => getTemplates("text-generation", "bad model; rm -rf /", "unsafe"),
    /Invalid model ID/
  );
});

test("getTemplates keeps model loading outside the request handler", () => {
  const { handler } = getTemplates("text-classification");
  const modelPosition = handler.indexOf("MODEL = pipeline");
  const handlerPosition = handler.indexOf("def handler");
  assert.ok(modelPosition >= 0 && modelPosition < handlerPosition);
});

test("getDefaultModel returns known defaults", () => {
  assert.equal(getDefaultModel("text-generation"), "gpt2");
  assert.equal(getDefaultModel("custom"), "");
});

test("extractJobResult parses SDK job output", () => {
  assert.equal(
    extractJobResult('prefix Job result: {"ok":true,"count":2}'),
    '{\n  "ok": true,\n  "count": 2\n}'
  );
});

test("extractJobResult returns null for unrelated output", () => {
  assert.equal(extractJobResult("worker started"), null);
});
