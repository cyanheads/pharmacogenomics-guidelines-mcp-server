<div align="center">
  <h1>@cyanheads/pharmacogenomics-guidelines-mcp-server</h1>
  <p><b>Find pharmacogenomics guidelines, translate diplotypes, and retrieve prescribing recommendations via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/pharmacogenomics-guidelines-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/pharmacogenomics-guidelines-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/pharmacogenomics-guidelines-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/pharmacogenomics-guidelines-mcp-server/releases/latest/download/pharmacogenomics-guidelines-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=pharmacogenomics-guidelines-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvcGhhcm1hY29nZW5vbWljcy1ndWlkZWxpbmVzLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22pharmacogenomics-guidelines-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fpharmacogenomics-guidelines-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://pharmacogenomics-guidelines.caseyjhand.com/mcp](https://pharmacogenomics-guidelines.caseyjhand.com/mcp)

</div>

---

## Overview

Clinical pharmacogenomics evidence from the public [CPIC Database API](https://api.cpicpgx.org/v1/): evaluated gene–drug pairs, guidelines, allele function and frequency, diplotype-to-phenotype translation, and prescribing recommendations, with ClinPGx testing labels and guideline links. You can discover pairs, translate a patient's diplotype, and browse recommendations or match them against explicitly supplied gene results. All six tools are read-only, need no API key, and run as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `pgx_search_pairs` | Search evaluated gene–drug pairs by gene, drug, RxNorm/ATC identifier, CPIC level or testing label |
| `pgx_get_guideline` | Retrieve guideline coverage by ID, gene or drug, with related drugs and pairs |
| `pgx_lookup_diplotype` | Translate a diplotype or HLA allele status into its gene result, activity score and lookup key |
| `pgx_get_recommendations` | Browse or match source prescribing recommendations and opt-in example CDS test alerts |
| `pgx_search_alleles` | Inspect allele function, evidence, definition metadata and population frequencies |
| `pgx_list_reference` | List genes, gene-specific results, controlled vocabulary and input formats |

## Capability reference

### `pgx_search_pairs` <sub>tool</sub>

- Optional filters, combined with AND: `geneSymbol`, `drugName` (literal substring), `drugId`, `rxnormId`, `atcId` (exact code, no hierarchy expansion), `cpicLevel`, `provisional`, `pgxTesting` and `usedForRecommendation`.
- RxNorm/ATC prefixes and ATC letters accept any casing in both advertised schemas and runtime validation. Outer whitespace is ignored; blank identifiers are unset.
- `limit` defaults to 25; positive safe integers above 100 clamp to 100 with a notice. Continue from `page.nextOffset`.
- Returns complete pair records, each with its drug record and guideline link. `Retired` pairs appear only with `includeRetired: true` or `cpicLevel: "Retired"`.

---

### `pgx_get_guideline` <sub>tool</sub>

- Three lookup modes; selectors from other modes are rejected:
  - `by: "id"` with `guidelineId`
  - `by: "gene"` with `geneSymbol`
  - `by: "drug"` with exactly one of `drugName` (exact, case-insensitive) or `drugId`
- Default `view: "summary"` pages complete guideline records with exact `drugCount` and `pairCount`. `view: "drugs"` or `"pairs"` requires `by: "id"`, retains the guideline descriptor, and pages the selected top-level collection; the other collection is omitted.
- `limit` defaults to 25; positive safe integers above 100 clamp to 100 with a notice. Follow `page.nextOffset`. Pages use a 24,000-byte soft budget across both response surfaces and enrichment, cutting only between complete rows. One indivisible oversized row sets `oversizedRow: true` with a notice.
- No coverage returns `found: false`. An ambiguous drug name returns paged `candidates`; `page`, `shown` and `truncated` then describe those candidates. Retry with a `drugId` from that list.

---

### `pgx_lookup_diplotype` <sub>tool</sub>

- Takes `geneSymbol` plus a source-supported `diplotype`, in either allele order:
  - star alleles (`*1/*2`, `*1x2/*4`)
  - HLA allele status (`*57:01 positive`)
  - non-star notation (`c.1905+1G>A (*2A)/Reference`)
- Returns `found`, `matchedDiplotype`, `guidance`, and every matching source record with its gene result, activity score, EHR priority and lookup key.
- Several matching records are left ambiguous, never resolved to one. No result is calculated.

---

### `pgx_get_recommendations` <sub>tool</sub>

- Omit `view` or use `view: "recommendations"` for prescribing recommendations. `view: "test_alerts"` selects CPIC's example CDS language with the same drug, genotype, result, population and paging selectors; it does not fetch recommendations or join guidelines.
- `mode: "drug"` takes exactly one of `drugName` (exact, case-insensitive) or `drugId`.
  - On its own, or with `geneSymbol` or `population`, it browses (`exploratory`).
  - To match, add `phenotype` or `activityScore`. These need `geneSymbol` when the drug's recommendations involve several genes.
  - Alternatively, add a `geneResults` map: 1–10 genes, each `{ kind: "phenotype" | "activityScore" | "alleleStatus", value }`.
- `mode: "genotype"` takes `genotype`: 1–10 gene → diplotype entries, each of which must resolve uniquely. An optional drug selector narrows the results.
- `mode: "results"` discovers across drugs from `geneResults`, or `geneSymbol` with one `phenotype`/`activityScore`. An optional drug selector narrows the results. Unrelated panel genes do not exclude a recommendation; conflicting results for its prerequisites do.
- Source gene `lookupmethod` determines accepted result kinds: `PHENOTYPE` permits `phenotype`; `ACTIVITY_SCORE` permits `phenotype` or `activityScore`; `ALLELE_STATUS` permits `alleleStatus`. Values are validated against source result/score fields. Phenotypes never become calculated scores. Inspect `pgx_list_reference` topics `genes` and `phenotypes` before matching.
- All modes accept an exact `population`, `limit` (default 10) and `offset`. Positive safe-integer limits above 50 clamp to 50 with a notice. `incompleteLimit` (default 25) independently clamps above 100; `incompleteOffset` pages missing-gene diagnostics through `incompletePage.nextOffset`.
- `status` is `exploratory`, `matched`, `no_match`, `incomplete` or `unresolved`. Drug and results matching require at least one overlapping supplied gene, reject conflicts on overlapping prerequisites, and ignore unrelated validated panel genes. A row matches only when every gene in its lookup key has an explicit result. `incompleteMatches` lists the rows that need more genes, with their `missingGenes` and without prescribing text.
- Empty-result notices distinguish unresolved drugs, absent recommendation tables, population mismatches and past-end pages. Where source coverage exists, a no-table notice links the guideline for consultation.
- Alert view returns complete source records in `alerts`, including ordered `alerttext`, singular `phenotype`, lookup keys, allele statuses, scores, populations and versions. `No CDS`, `n/a`, sparse fields and explicit source `No Result` rows remain intact. Omitted genetics never become `No Result`. Missing prerequisites appear only as `{ testAlertId, drugId, missingGenes }` in `incompleteAlerts`, without alert text. `items` and `incompleteMatches` remain empty; `page` and `incompletePage` describe alerts and diagnostics. Default responses omit both alert fields.

---

### `pgx_search_alleles` <sub>tool</sub>

- Requires `geneSymbol`. `name` matches literally first, then retries a matching gene-prefixed star allele without that prefix. `clinicalFunctionalStatus` matches literal text case-insensitively. Returned source spelling stays unchanged; `effectiveQuery` shows the allele name used.
- `limit` defaults to 25; positive safe integers above 100 clamp to 100 with a notice. Nonpositive, fractional and unsafe limits fail before fetching. `offset` is a nonnegative safe integer.
- The 24,000-byte soft budget measures the entire serialized tool result, including both response surfaces and enrichment. It cuts only between complete alleles, keeping every frequency row. An indivisible oversized first row sets `oversizedRow: true` with a notice. Follow `page.nextOffset` to reconstruct the remaining rows.
- Returns allele function and evidence with definition metadata and `populationFrequencies`. Frequencies stay as source fractions, missing values stay missing, and inferred frequencies are flagged as inferred.

---

### `pgx_list_reference` <sub>tool</sub>

- `topic` is one of:
  - `genes` — optional `geneSymbol` filter
  - `phenotypes` — requires `geneSymbol`
  - `cpic_levels`, `pgx_testing`, `classifications`, `input_formats`
- The two live topics (`genes`, `phenotypes`) page with `limit` (default 25) and `offset`; positive safe-integer limits above 100 clamp to 100 with a notice. They return full gene and gene-result records, including distinct activity scores, frequencies and consultation text.
- Static topics return their whole vocabulary without calling the CPIC API. They reject `geneSymbol` and carry a `verificationDate`.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

CPIC-specific:

- One lookup chain: reference values → pairs → guidelines → allele and diplotype evidence → recommendations
- CPIC evaluation levels, ClinPGx testing labels and recommendation classifications are kept separate. A testing label is not an FDA label, and an evaluated pair is not a recommendation.
- Matching uses only results you supply. An omitted gene is never assumed normal, negative or `Indeterminate`. Phenotypes, decimal activity scores and HLA allele statuses are each checked against CPIC's own values.
- Bounded workflows:
  - 45-second deadline, at most 100 HTTP attempts, three concurrent requests, two retries per request
  - Related scans stop at 2,000 rows (drug resolution 500). Guideline lists and detail views page at the source; related counts use exact source totals, with bounded scans only when totals are missing. Past a scan cap the call fails as `query_too_broad` rather than returning partial results.

Agent-friendly output:

- **Provenance:** exact deduplicated request URLs, access timestamp, returned row versions, and license and policy links. Each version uses an RFC 6901 JSON Pointer into the result and a `requestIndex` into `requestUrls`. API `v1` names the interface, not a database release.
- **Explicit outcomes:** recommendation `status`, per-gene `geneResolutions`, `incompleteMatches`, and typed error reasons with recovery text.
- **Lossless text output:** `content[]` carries the complete result as JSON with one clickable link per distinct destination in each rendered block, matching `structuredContent`. `effectiveQuery`, `notices` and `page` (`total`, `nextOffset`) explain every result.

### Source attribution and clinical limitations

Data comes from the [CPIC Database](https://api.cpicpgx.org/v1/) and [ClinPGx](https://www.clinpgx.org/). The [CPIC data license](https://github.com/cpicpgx/cpic-data/blob/master/LICENSE.md) and the [ClinPGx usage policy](https://www.clinpgx.org/page/dataUsagePolicy) cover the source data; this repository's Apache-2.0 license covers its code.

The database tables can omit guideline nuances or lag behind guideline updates, so check each linked guideline before clinical use. Results apply only to their stated genes, drugs, populations and indications, and treatment decisions remain with the clinician and patient. The server stores no patient records, but genetic queries are sent to the CPIC API, and the request URLs, which contain them, appear in responses.

## Getting started

### Public Hosted Instance

A public instance is available at `https://pharmacogenomics-guidelines.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "pharmacogenomics-guidelines-mcp-server": {
      "type": "streamable-http",
      "url": "https://pharmacogenomics-guidelines.caseyjhand.com/mcp"
    }
  }
}
```

Queries to the hosted instance pass through its server on the way to the CPIC API. For patient data, run your own instance.

### Self-Hosted / Local

Add the following to your MCP client configuration file:

```json
{
  "mcpServers": {
    "pharmacogenomics-guidelines-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/pharmacogenomics-guidelines-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "pharmacogenomics-guidelines-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/pharmacogenomics-guidelines-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "pharmacogenomics-guidelines-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/pharmacogenomics-guidelines-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bunx @cyanheads/pharmacogenomics-guidelines-mcp-server@latest
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- Network access to `https://api.cpicpgx.org`. No API key is needed.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/pharmacogenomics-guidelines-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd pharmacogenomics-guidelines-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# optional: adjust transport, logging, or telemetry settings
```

## Configuration

No server-specific environment variables are required.

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_HOST` | HTTP bind address. | `127.0.0.1` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | MCP endpoint path. | `/mcp` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful` or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt` or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `debug` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the common framework overrides.

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:

  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools/definitions` | The six tool definitions and the `allToolDefinitions` registry. |
| `src/mcp-server/tools/shared` | Paging schemas and lossless Markdown rendering. |
| `src/services/cpic` | Fixed-host CPIC requests, source record schemas, discovery, evidence and recommendation matching. |
| `tests/unit` | Service, tool contract, boundary and formatter tests. |
| `docs` | Design contract and generated directory tree. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools in `allToolDefinitions` (`src/mcp-server/tools/definitions/index.ts`), which `src/index.ts` passes to `createApp()`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
