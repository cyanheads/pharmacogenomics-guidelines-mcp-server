/**
 * @fileoverview Operator configuration for the genetic panel size limit.
 * @module config/server-config
 */
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const schema = z.object({ largeGenePanels: z.stringbool().default(true) });
let config: z.infer<typeof schema> | undefined;

/** Validate once at startup and reuse the same limit for every request. */
export function getServerConfig() {
  config ??= parseEnvConfig(schema, { largeGenePanels: 'PGX_LARGE_GENE_PANELS' });
  return config;
}
