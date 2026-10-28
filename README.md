# AI Answer Visibility Tracker MCP Server

[![Smithery](https://smithery.ai/badge/mambabuilt/mcp-ai-answer-visibility-tracker)](https://smithery.ai/servers/mambabuilt/mcp-ai-answer-visibility-tracker) [![Glama score](https://glama.ai/mcp/servers/mambalabsdev/mcp-ai-answer-visibility-tracker/badges/score.svg)](https://glama.ai/mcp/servers/mambalabsdev/mcp-ai-answer-visibility-tracker) [![MCP Registry](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fregistry.modelcontextprotocol.io%2Fv0%2Fservers%3Fsearch%3Dcom.mambabuilt%252Fmcp-ai-answer-visibility-tracker%26limit%3D1&query=%24.servers%5B0%5D._meta%5B%22io.modelcontextprotocol.registry%2Fofficial%22%5D.status&label=mcp%20registry&color=blue)](https://registry.modelcontextprotocol.io/v0/servers?search=com.mambabuilt/mcp-ai-answer-visibility-tracker&limit=1) [![npm version](https://img.shields.io/npm/v/@mambalabsdev/mcp-ai-answer-visibility-tracker)](https://www.npmjs.com/package/@mambalabsdev/mcp-ai-answer-visibility-tracker) [![npm downloads](https://img.shields.io/npm/dm/@mambalabsdev/mcp-ai-answer-visibility-tracker)](https://www.npmjs.com/package/@mambalabsdev/mcp-ai-answer-visibility-tracker) [![license](https://img.shields.io/github/license/mambalabsdev/mcp-ai-answer-visibility-tracker)](https://github.com/mambalabsdev/mcp-ai-answer-visibility-tracker/blob/main/LICENSE) [![mcpservers.org](https://img.shields.io/badge/mcpservers.org-listed-blue)](https://mcpservers.org/servers/mambalabsdev/mcp-ai-answer-visibility-tracker)

An MCP server for the Mamba Labs AI Answer Visibility Tracker actor on Apify. Give it a brand and the questions its buyers ask. Each question is asked several times on Google AI Overviews and, on your own API keys, on ChatGPT, Claude, Perplexity, and Gemini, and every answer is checked for the brand.

## What's Inside

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Prerequisites](#prerequisites)
- [Example prompts](#example-prompts)
- [Tool](#tool)
- [Inputs](#inputs)
- [Pricing](#pricing)
- [Your keys](#your-keys)
- [Full actor documentation](#full-actor-documentation)
- [License](#license)

## What it does

- **Sample rows**: one row per answer, with `brand_named`, `brand_cited`, `first_mention_rank`, `competitors_named`, `competitors_cited`, `cited_domains`, and an answer excerpt.
- **Rates rows**: one `question_summary` row per question and engine, with `brand_named_rate`, `brand_cited_rate`, a 95 percent range for the named rate, the top cited domains, and each competitor's rates. One free `brand_summary` row per engine covers all questions.
- **Google AI Overviews with no key**: `shown`, `not_shown` (no overview on the page), or `deferred` (Google writes the overview live and loads it after the page; free and left out of the rates).

Bad input returns one free row whose `error_reason` starts with `input_invalid:`.

All of the work runs on Apify. This package is a thin client that starts the actor run, waits for it, and hands back the dataset rows.

## Quick start

You need Node.js 18 or newer and an Apify account with an API token.

Add this to your Claude Desktop config (`claude_desktop_config.json`), Cursor, or any MCP client:

```json
{
  "mcpServers": {
    "mamba-ai-answer-visibility-tracker": {
      "command": "npx",
      "args": [
        "-y",
        "@mambalabsdev/mcp-ai-answer-visibility-tracker"
      ],
      "env": {
        "APIFY_TOKEN": "your-apify-token"
      }
    }
  }
}
```

Restart the client. The `track_ai_answer_visibility` tool appears.

To ask ChatGPT, Claude, Perplexity, or Gemini as well, add that vendor's key to the same `env` block: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `PERPLEXITY_API_KEY`, or `GEMINI_API_KEY`.

## Prerequisites

- Node.js 18 or newer.
- An Apify API token from [console.apify.com/account/integrations](https://console.apify.com/account/integrations), set as `APIFY_TOKEN`. The server lists its tool without a token; a call needs one.
- Optional: your own OpenAI, Anthropic, Perplexity, or Google AI Studio key for those engines.

## Example prompts

- "Does Google's AI Overview mention HubSpot for best crm for small business? Ask 3 times."
- "For these 10 questions, how often do AI answers name Attio, and how often do they name HubSpot and Pipedrive?"
- "Which sites do AI Overviews cite most for best wiki tool for a remote team?"

## Tool

`track_ai_answer_visibility`. One tool. Example arguments:

```json
{
  "brand_name": "HubSpot",
  "brand_domain": "hubspot.com",
  "questions": [
    "best crm for small business"
  ],
  "samples": "3",
  "competitors": [
    "Pipedrive|pipedrive.com",
    "zoho.com"
  ]
}
```

## Inputs

Every buyer facing input of the actor except the four engine keys, which come from the server environment so they never pass through the conversation. Omitted inputs take the actor's own defaults. Numbers and booleans are sent as strings.

| Input | Type | Description |
|---|---|---|
| `brand_name` | string | Required. The brand to look for, as people write it. Matched as a whole word, any case |
| `questions` | array | Required. 1 to 50 questions buyers ask |
| `brand_domain` | string | The brand domain, such as hubspot.com. A cited page on it, or on a subdomain, counts as cited |
| `engines` | array | Any of google_ai_overview, openai, anthropic, perplexity, gemini. Default google_ai_overview |
| `samples` | string | Asks per question per engine, 1 to 10. Default 3 |
| `competitors` | array | Up to 20, as a name, a domain, or name\|domain |
| `brand_aliases` | array | Other ways answers write the brand |
| `country`, `language` | string | For Google. Default us, en |
| `include_answer_text` | string | true (default) or false |
| `openai_model`, `anthropic_model`, `perplexity_model`, `gemini_model` | string | Defaults gpt-5-mini, claude-sonnet-5-5, sonar, gemini-2.5-flash |
| `max_charge_usd` | string | Optional. The run stops before it would charge more than this |

## Pricing

Pay per event on Apify, billed to your Apify account. Prices in USD.

| Event | Free plan | Bronze | Silver | Gold |
|---|---|---|---|---|
| `ai-overview-sample`, one Google result page read for one question | $0.023 | $0.02185 | $0.0207 | $0.01955 |
| `answer-sample`, one answer from ChatGPT, Claude, Perplexity, or Gemini on your own key | $0.009 | $0.00855 | $0.0081 | $0.00765 |
| `question-summary`, one rates row per question and engine | $0.003 | $0.00285 | $0.0027 | $0.00255 |
| `apify-actor-start`, per run start | $0.001 | $0.001 | $0.001 | $0.001 |

Deferred Google samples, blocked pages, engine errors, the brand rates rows, and refused input are free.

## Your keys

Google AI Overviews needs no key. ChatGPT, Claude, Perplexity, and Gemini run on your own API key, read from this server's environment and passed in the run input as a secret field. The actor sends a key only to that vendor's API and never logs, stores, or returns it. The model use is billed to you by that vendor. Mamba Labs pays the Apify platform and proxy costs of the run.

## Full actor documentation

[apify.com/mambalabs/ai-answer-visibility-tracker](https://apify.com/mambalabs/ai-answer-visibility-tracker)

## License

MIT. See [LICENSE](LICENSE).
