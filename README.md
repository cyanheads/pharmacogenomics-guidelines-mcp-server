<div align="center">
  <h1>pharmacogenomics-guidelines-mcp-server</h1>
  <p><b>Find pharmacogenomics guidelines, translate diplotypes, and retrieve prescribing recommendations via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/pharmacogenomics-guidelines-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/pharmacogenomics-guidelines-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/pharmacogenomics-guidelines-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.3-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/pharmacogenomics-guidelines-mcp-server/releases/latest/download/pharmacogenomics-guidelines-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=pharmacogenomics-guidelines-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvcGhhcm1hY29nZW5vbWljcy1ndWlkZWxpbmVzLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22pharmacogenomics-guidelines-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fpharmacogenomics-guidelines-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Pharmacogenomics evidence from the public [CPIC Database API](https://api.cpicpgx.org/v1/), with clinical source context from [ClinPGx](https://www.clinpgx.org/). Discover evaluated gene–drug pairs, inspect guideline coverage and allele evidence, translate source-supported diplotypes, and browse or match source prescribing recommendations. All six tools are read-only and require no API key.

### Tools

| Tool | Description |
|:---|:---|
| `pgx_search_pairs` | Discover evaluated gene–drug pairs and their source identifiers |
| `pgx_get_guideline` | Retrieve guideline coverage and related drugs and pairs |
| `pgx_lookup_diplotype` | Resolve source-supported diplotypes or allele-specific statuses |
| `pgx_get_recommendations` | Browse recommendations or match explicitly supplied genetic results |
| `pgx_search_alleles` | Inspect allele function, definition metadata and population frequencies |
| `pgx_list_reference` | List genes, source results, controlled vocabulary and input formats |

## Capability reference

### `pgx_search_pairs` <sub>tool</sub>

- Optional `geneSymbol`, literal `drugName` substring, exact `drugId`, `rxnormId` or `atcId`, `cpicLevel`, `provisional`, `pgxTesting`, and `usedForRecommendation`; all filters combine with AND. RxNorm and ATC prefixes are optional; ATC matching is exact membership, without hierarchy expansion.
- Complete pair and drug records with guideline links. Retired pairs are excluded unless `includeRetired: true` or `cpicLevel: "Retired"`; an evaluated pair is not a prescribing recommendation.
- `limit` 1–100 (default 25), `offset` default 0; continue with `page.nextOffset`.

---

### `pgx_get_guideline` <sub>tool</sub>

- `by: "id"` requires `guidelineId`; `by: "gene"` requires `geneSymbol`; `by: "drug"` requires exactly one `drugName` or `drugId`. Drug names are exact and case-insensitive; omit selectors from other modes.
- Returns every matching guideline with complete related drug/pair lists, source versions, links and clinical caveat. Missing coverage returns `found: false`; ambiguous drug names return `candidates` for a retry with `drugId`.

---

### `pgx_lookup_diplotype` <sub>tool</sub>

- Requires `geneSymbol` and source-supported `diplotype`: star alleles such as `*1/*2`, named HLA allele status such as `*15:02 positive`, or non-star sequence notation. Exact lookup precedes bounded reverse-order and status aliases; it does not interpret arbitrary variants.
- Returns `found`, `matchedDiplotype`, complete source `records` and `guidance`. Multiple records remain ambiguous; activity scores and missing results are never calculated.

---

### `pgx_get_recommendations` <sub>tool</sub>

- `mode: "drug"` requires exactly one `drugName` (exact, case-insensitive) or `drugId`. Drug-only browsing is `exploratory`, including optional `geneSymbol`/`population` filters. To match results, supply either `phenotype` or `activityScore` (with `geneSymbol` unless the drug has exactly one recommendation gene), or `geneResults` for 1–10 genes as `{ "GENE": { "kind": "phenotype" | "activityScore" | "alleleStatus", "value": "source value" } }`; the map excludes scalar result fields.
- `mode: "genotype"` requires `genotype` with 1–10 gene/diplotype entries, optionally one drug selector; scalar results and `geneResults` are excluded. Every supplied genotype must resolve uniquely. Both modes accept an exact `population` filter and `limit` 1–50 (default 10), `offset` default 0.
- `status` is `exploratory`, `matched`, `no_match`, `incomplete` or `unresolved`. Matched rows require every source genetic prerequisite; `incompleteMatches` lists identifiers and `missingGenes` without prescribing text. Omitted genes are never assumed normal or negative. Complete records retain populations, activity scores, allele statuses, `No Recommendation` and `n/a`; phenotype matching can retain several distinct scores.

---

### `pgx_search_alleles` <sub>tool</sub>

- Requires `geneSymbol`; optional exact `name` and `clinicalFunctionalStatus` filters. `limit` 1–100 (default 25), `offset` default 0; continue with `page.nextOffset`.
- Complete allele evidence, embedded definition metadata and `populationFrequencies`. Definitions do not promise defining variants; frequency fractions stay fractions, missing values are not zero, inferred frequencies are not observed measurements, and population frequencies do not establish individual risk.

---

### `pgx_list_reference` <sub>tool</sub>

- `topic`: `genes`, `phenotypes`, `cpic_levels`, `pgx_testing`, `classifications` or `input_formats`. `phenotypes` requires `geneSymbol`; `genes` optionally filters by it. Live topics accept `limit` 1–100 (default 25) and `offset` (default 0).
- Live gene/result records retain distinct scores, consultation text and versions. Static topics return their complete vocabulary without an upstream request, reject gene filters and report `verificationDate` instead of a live access timestamp.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

CPIC-specific:

- A source lookup workflow: inspect reference values → discover pairs → retrieve guidelines → inspect allele/diplotype evidence → browse or match recommendations.
- CPIC evaluation levels, ClinPGx testing labels and prescribing recommendation classifications remain separate. ClinPGx testing labels are not FDA labels.
- Bounded requests: a 45-second workflow deadline, at most 100 HTTP attempts, three concurrent requests and two retries per request. Related scans cap at 2,000 rows (drug resolution at 500, guidelines at 100); `query_too_broad` fails instead of silently returning an incomplete scan.

Agent-friendly output:

- Provenance — exact request URLs, access timestamps, row versions and source license/policy links; API `v1` identifies the interface, not a database release or atomic snapshot.
- Explicit outcomes — recommendation `status`, per-gene resolution diagnostics, missing prerequisites and actionable recovery guidance.
- Complete data — `content[]` and `structuredContent` carry the same source data, including links and clinical text; `effectiveQuery`, `notices` and page metadata explain the result. `page.total` is null when a source count is unavailable.

### Source attribution and clinical limitations

Data comes from the [CPIC Database](https://api.cpicpgx.org/v1/) and [ClinPGx](https://www.clinpgx.org/). Consult the [CPIC data license](https://github.com/cpicpgx/cpic-data/blob/master/LICENSE.md) and [ClinPGx usage policy](https://www.clinpgx.org/page/dataUsagePolicy) for source terms; this repository's Apache-2.0 license covers its code.

Database/API tables may omit guideline nuances or lag updates. Consult each linked guideline and its updates before clinical use. Results apply only to their stated genes, drugs, populations and indications; treatment decisions remain with the clinician and patient. The tools retrieve source evidence and match explicit results; they do not infer clinical results, calculate personal risk or synthesize patient-specific dosing. No patient record is stored by the service; genetic queries are sent to the upstream API and request URLs appear in responses.

## Getting started

### Self-Hosted / Local

Add the following to your MCP client configuration file:

```json
{
  "mcpServers": {
    "pharmacogenomics-guidelines-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/pharmacogenomics-guidelines-mcp-server@latest"],
      "env": { "MCP_TRANSPORT_TYPE": "stdio", "MCP_LOG_LEVEL": "info" }
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
      "env": { "MCP_TRANSPORT_TYPE": "stdio", "MCP_LOG_LEVEL": "info" }
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

For Streamable HTTP:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bunx @cyanheads/pharmacogenomics-guidelines-mcp-server@latest
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher, or Node.js v24+.
- Network access to `https://api.cpicpgx.org`; no API key is needed.

### Installation

```sh
git clone https://github.com/cyanheads/pharmacogenomics-guidelines-mcp-server.git
cd pharmacogenomics-guidelines-mcp-server
bun install
cp .env.example .env
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
| `OTEL_ENABLED` | Enable OpenTelemetry. | `false` |

See [`.env.example`](./.env.example) for the common framework overrides.

## Running the server

### Local development

- **Build and run the production version**:

  ```sh
  bun run rebuild
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:

  ```sh
  bun run devcheck
  bun run test
  ```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/mcp-server/tools/definitions` | Six read-only tool definitions. |
| `src/mcp-server/tools/shared` | Paging schemas and lossless Markdown rendering. |
| `src/services/cpic` | Fixed-host API requests, source records, discovery, evidence and matching. |
| `tests/unit` | Service, tool contract, boundary and formatter tests. |
| `docs` | Design contract and generated directory tree. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools and resources in the `createApp()` arrays in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
