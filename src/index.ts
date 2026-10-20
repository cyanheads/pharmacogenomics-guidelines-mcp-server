#!/usr/bin/env node
/**
 * @fileoverview pharmacogenomics-guidelines-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { echoTool } from './mcp-server/tools/definitions/echo.tool.js';

await createApp({
  name: 'pharmacogenomics-guidelines-mcp-server',
  title: 'pharmacogenomics-guidelines-mcp-server',
  tools: [echoTool],
});
