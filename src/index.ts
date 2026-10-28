#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string; name: string };

// Distinctive UA so Apify run meta.userAgent marks MCP-originated runs.
const USER_AGENT = `mambalabs-mcp ${pkg.name}@${pkg.version}`;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

// Drop undefined values so optional inputs are not sent to the actor.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// How long the actor run itself is allowed to take, in seconds: the one fleet
// wrapper timeout, 1800 s (set 2026-10-05). The actor stops starting samples
// 90 s before it and returns the rows it has, so a very large question list
// ends SUCCEEDED with the samples done in that time.
const ACTOR_RUN_TIMEOUT_SECS = 1800;

// How long this wrapper waits for that run, in milliseconds. The actor's own
// timeout plus two minutes, so the run's own TIMED-OUT status is what the
// caller sees rather than the wrapper giving up first and reporting nothing.
const WRAPPER_WAIT_MS = (ACTOR_RUN_TIMEOUT_SECS + 120) * 1000;
const POLL_INTERVAL_MS = 3000;

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED", "ABORTING"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shared caller. actorPath is the actor's immutable Apify actor ID (a stable key
// that survives Store renames). The /v2/acts/{id} endpoint accepts it directly,
// so a Store rename never breaks these calls.
//
// START AND POLL, NOT RUN-SYNC. Apify's synchronous endpoints carry a platform
// ceiling of 300 seconds on the HTTP wait itself and answer 408 past it whatever
// the timeout parameter says, so a long run reads as a timeout even though the
// actor goes on to finish. Starting the run, polling it to a terminal status and
// then reading the dataset is the only way to wait as long as the actor needs.
//
// The token is read here rather than at module load, so the tool registers
// unconditionally and a server started without APIFY_TOKEN still advertises its
// capabilities instead of reporting none.
async function runActor(
  actorPath: string,
  actorLabel: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  if (!APIFY_TOKEN) {
    return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
  }

  const headers = {
    Authorization: `Bearer ${APIFY_TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };

  const httpError = async (response: Response): Promise<string> => {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }
    switch (response.status) {
      case 400:
        return `The ${actorLabel} run was rejected as invalid input.${detail}`;
      case 401:
        return "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
      case 402:
        return "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
      default:
        return `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
  };

  // 1. Start the run.
  let started: Response;
  try {
    started = await fetch(
      `https://api.apify.com/v2/acts/${actorPath}/runs?timeout=${ACTOR_RUN_TIMEOUT_SECS}`,
      { method: "POST", headers, body: JSON.stringify(input) },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }
  if (!started.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(started) }] };
  }

  let run: { id?: string; status?: string; defaultDatasetId?: string };
  try {
    run = ((await started.json()) as { data?: typeof run }).data ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned a response that could not be parsed: ${message}` }] };
  }
  const runId = run.id;
  if (!runId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned no run id, so there is nothing to wait for.` }] };
  }

  // 2. Poll to a terminal status.
  const deadline = Date.now() + WRAPPER_WAIT_MS;
  let status = run.status ?? "READY";
  let datasetId = run.defaultDatasetId;
  while (!TERMINAL.has(status)) {
    if (Date.now() >= deadline) {
      return {
        isError: true,
        content: [{ type: "text", text: `The ${actorLabel} run ${runId} was still ${status} after ${Math.round(WRAPPER_WAIT_MS / 1000)} seconds and this call stopped waiting. The run itself is still on Apify: read it at https://console.apify.com/actors/runs/${runId}` }],
      };
    }
    await sleep(POLL_INTERVAL_MS);
    let poll: Response;
    try {
      poll = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, { headers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `Lost contact with the Apify API while waiting for ${actorLabel} run ${runId}: ${message}` }] };
    }
    if (!poll.ok) {
      return { isError: true, content: [{ type: "text", text: await httpError(poll) }] };
    }
    const body = (await poll.json()) as { data?: { status?: string; defaultDatasetId?: string } };
    status = body.data?.status ?? status;
    datasetId = body.data?.defaultDatasetId ?? datasetId;
  }

  // 3. A run that did not succeed is a failure the caller must see, never an
  // empty success. Surfacing it here is what keeps a crashed run from reading
  // as "no results found".
  if (status !== "SUCCEEDED") {
    return {
      isError: true,
      content: [{ type: "text", text: `The ${actorLabel} run did not succeed (run ID: ${runId}, status: ${status}).` }],
    };
  }
  if (!datasetId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run ${runId} succeeded but reported no dataset, so there is nothing to return.` }] };
  }

  // 4. Read the dataset.
  let ds: Response;
  try {
    ds = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?format=json`, { headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not read the ${actorLabel} dataset: ${message}` }] };
  }
  if (!ds.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(ds) }] };
  }

  let items: unknown;
  try {
    items = await ds.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run returned a response that could not be parsed: ${message}` }] };
  }

  if (!Array.isArray(items)) {
    const asObj = items as { error?: { type?: string; message?: string } };
    const detail = asObj?.error?.message
      ? `${asObj.error.message}`
      : JSON.stringify(items);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run did not return a dataset. ${detail}` }] };
  }

  return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
}

const server = new McpServer({
  name: "mamba-ai-answer-visibility-tracker",
  version: pkg.version,
});

// AI Answer Visibility Tracker (immutable actor ID RJZvzKniYK4nswcMg). Every buyer facing input of the actor
// is exposed except the four engine API keys: those are read from this server's environment
// (OPENAI_API_KEY, ANTHROPIC_API_KEY, PERPLEXITY_API_KEY, GEMINI_API_KEY) and added to the run input,
// so a key never passes through the conversation. The actor takes numbers and booleans as strings.
const ENGINE_KEYS: Array<[string, string]> = [
  ["openai_api_key", "OPENAI_API_KEY"],
  ["anthropic_api_key", "ANTHROPIC_API_KEY"],
  ["perplexity_api_key", "PERPLEXITY_API_KEY"],
  ["gemini_api_key", "GEMINI_API_KEY"],
];
function withEngineKeys(args: Record<string, unknown>, env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out = { ...args };
  for (const [field, name] of ENGINE_KEYS) {
    const v = env[name];
    if (v && String(v).trim()) out[field] = String(v).trim();
  }
  return out;
}

server.registerTool(
  "track_ai_answer_visibility",
  {
    title: "Track brand visibility in AI answers",
    description:
      "Check whether AI answers name and cite a brand for the questions its buyers ask. Give brand_name, brand_domain, and questions (for example \"best crm for small business\"). Each question is asked samples times (default 3) on each engine: google_ai_overview needs no key; openai (ChatGPT), anthropic (Claude), perplexity, and gemini run on the caller's own API keys, which this server reads from its environment (OPENAI_API_KEY, ANTHROPIC_API_KEY, PERPLEXITY_API_KEY, GEMINI_API_KEY). Returns one sample row per answer (brand_named, brand_cited, first_mention_rank, competitors_named, cited_domains, answer_excerpt), one question_summary row per question and engine (brand_named_rate, brand_cited_rate with a 95 percent range, top_cited_domains, competitor rates), and one free brand_summary row per engine. Bad input returns one free row whose error_reason starts with input_invalid. A run that does not succeed is returned as an error with its run ID. Read-only; requires an APIFY_TOKEN; Apify charges per Google sample, per engine sample, and per question rates row.",
    annotations: {
      title: "Track brand visibility in AI answers",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      brand_name: z.string().describe("The brand to look for in the answers, as people write it, for example HubSpot. Matched as a whole word, any case."),
      questions: z.array(z.string()).describe("1 to 50 questions buyers ask, written the way they would type them, for example best crm for small business."),
      brand_domain: z.string().optional().describe("The brand website domain, such as hubspot.com. An answer that cites a page on it, or on a subdomain, counts as cited."),
      engines: z.array(z.enum(["google_ai_overview", "openai", "anthropic", "perplexity", "gemini"])).optional().describe("Where to ask. Default google_ai_overview only. openai, anthropic, perplexity, and gemini need that vendor's API key in this server's environment; the model use is billed to the key owner by the vendor."),
      samples: z.string().optional().describe("How many times each question is asked on each engine, 1 to 10. Default 3."),
      competitors: z.array(z.string()).optional().describe("Up to 20 competitors to track in the same answers, as a name, a domain, or name|domain (Pipedrive|pipedrive.com)."),
      brand_aliases: z.array(z.string()).optional().describe("Other ways answers write the brand, such as a product name. Up to 10."),
      country: z.string().optional().describe("Two letter country code for Google, such as us or gb. Default us."),
      language: z.string().optional().describe("Language code for Google, such as en or de. Default en."),
      include_answer_text: z.enum(["true", "false"]).optional().describe("true (default) returns the answer text up to 8,000 characters on each sample row; false returns the 300 character excerpt only."),
      openai_model: z.string().optional().describe("Model for the openai engine. Default gpt-5-mini."),
      anthropic_model: z.string().optional().describe("Model for the anthropic engine. Default claude-sonnet-5-5."),
      perplexity_model: z.string().optional().describe("Model for the perplexity engine. Default sonar."),
      gemini_model: z.string().optional().describe("Model for the gemini engine. Default gemini-2.5-flash."),
      max_charge_usd: z.string().optional().describe("Optional. The run stops before it would charge more than this."),
    },
  },
  async (args) => runActor("RJZvzKniYK4nswcMg", "AI Answer Visibility Tracker", withEngineKeys(compact(args as Record<string, unknown>), process.env)),
);

const transport = new StdioServerTransport();
await server.connect(transport);
