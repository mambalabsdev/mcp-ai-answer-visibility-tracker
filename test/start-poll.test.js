import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..");

const TOOL_NAME = "track_ai_answer_visibility";
const ACTOR_ID = "RJZvzKniYK4nswcMg";
const ARGS = {"brand_name": "HubSpot", "brand_domain": "hubspot.com", "questions": ["best crm for small business"], "samples": "1"};

// Call the tool over stdio against the built server with fetch replaced by a
// fake Apify API (test/mock-fetch.mjs). Returns the tools/call result and the
// list of requests the server made.
function callTool(mode, extraEnv = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "mcp-mock-"));
  const log = join(tmp, "requests.log");
  const bodyLog = join(tmp, "bodies.log");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", pathToFileURL(join(here, "mock-fetch.mjs")).href, join(repo, "build", "index.js")],
      { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", PERPLEXITY_API_KEY: "", GEMINI_API_KEY: "", APIFY_TOKEN: "test-token", MOCK_LOG: log, MOCK_BODY: bodyLog, MOCK_MODE: mode, ...extraEnv } },
    );
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out. stderr: ${err}`));
    }, 30000);
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 2) {
          clearTimeout(timer);
          child.kill();
          const requests = readFileSync(log, "utf8").trim().split("\n");
          let bodies = [];
          try { bodies = readFileSync(bodyLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { bodies = []; }
          resolve({ result: msg.result, requests, bodies });
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      err += chunk.toString();
    });
    child.on("error", reject);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "wrapper-test", version: "0.0.0" } } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: TOOL_NAME, arguments: ARGS } }) + "\n");
  });
}

test("starts the run and polls it, never the run-sync endpoint", async () => {
  const { result, requests } = await callTool("ok");
  assert.ok(!result.isError, result.content?.[0]?.text);
  assert.deepEqual(JSON.parse(result.content[0].text), [{ row_status: "ok", error_reason: null }]);
  assert.ok(requests[0].startsWith(`POST https://api.apify.com/v2/acts/${ACTOR_ID}/runs?`), requests[0]);
  assert.ok(requests.some((r) => r.includes("/v2/actor-runs/run1")), "never polled the run");
  assert.ok(requests.some((r) => r.includes("/v2/datasets/ds1/items")), "never read the dataset");
  assert.ok(!requests.some((r) => r.includes("run-sync")), "called a run-sync endpoint");
});

test("a run that does not succeed is an error naming the run", async () => {
  const { result } = await callTool("fail");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /run1/);
  assert.match(result.content[0].text, /FAILED/);
});

test("engine keys come from the server environment, never from the tool arguments", async () => {
  const { bodies } = await callTool("ok", { OPENAI_API_KEY: "sk-env-test", PERPLEXITY_API_KEY: "pplx-env-test" });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].openai_api_key, "sk-env-test");
  assert.equal(bodies[0].perplexity_api_key, "pplx-env-test");
  assert.equal(bodies[0].anthropic_api_key, undefined);
  assert.equal(bodies[0].brand_name, "HubSpot");
  const { bodies: none } = await callTool("ok");
  assert.ok(!Object.keys(none[0]).some((k) => k.endsWith("_api_key")));
});
