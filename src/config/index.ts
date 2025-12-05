/**
 * Centralized Configuration Module
 *
 * All environment variables and configuration settings are defined here
 * with proper defaults, type coercion, and validation.
 */

/**
 * Parse integer from environment variable with default
 */
function parseIntEnv(envVar: string | undefined, defaultValue: number): number {
  if (!envVar) return defaultValue;
  const parsed = parseInt(envVar, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Parse string array from comma-separated environment variable
 */
function parseStringArrayEnv(envVar: string | undefined): string[] {
  if (!envVar) return [];
  return envVar
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse JSON from environment variable with fallback
 */
function parseJsonEnv<T>(envVar: string | undefined, defaultValue: T): T {
  if (!envVar) return defaultValue;
  try {
    return JSON.parse(envVar) as T;
  } catch {
    console.warn(`[Config] Failed to parse JSON from environment variable`);
    return defaultValue;
  }
}

/**
 * Centralized configuration object
 */
export const config = {
  // Server configuration
  server: {
    port: parseIntEnv(process.env.PORT, 3001),
    nodeEnv: process.env.NODE_ENV || 'development',
    corsOrigin: process.env.CORS_ORIGIN || '*',
  },

  // Request handling
  request: {
    timeoutMs: parseIntEnv(process.env.REQUEST_TIMEOUT_MS, 360000), // 6 minutes
    bodyLimit: '10mb',
  },

  // Agent configuration (one-off agent execution)
  agent: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.AGENT_MODEL || 'claude-sonnet-4-20250514',
    timeoutMs: parseIntEnv(process.env.AGENT_TIMEOUT_MS, 300000), // 5 minutes
    disallowedTools: parseStringArrayEnv(process.env.DISALLOWED_TOOLS),
  },

  // Workflow agent configuration (multi-step workflows)
  workflow: {
    agentModel:
      process.env.WORKFLOW_AGENT_MODEL || 'claude-haiku-4-5-20251001',
    classifierModel:
      process.env.CLASSIFIER_MODEL || 'claude-haiku-4-5-20251001',
  },

  // Supabase configuration
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_KEY,
    storageBucket: process.env.SUPABASE_STORAGE_BUCKET || 'agent-files',
  },

  // File handling
  files: {
    maxSizeMb: parseIntEnv(process.env.MAX_FILE_SIZE_MB, 50),
    maxSizeBytes: parseIntEnv(process.env.MAX_FILE_SIZE_MB, 50) * 1024 * 1024,
  },

  // Security
  security: {
    rateLimitMax: parseIntEnv(process.env.RATE_LIMIT_MAX, 60),
    rateLimitWindowMs: parseIntEnv(process.env.RATE_LIMIT_WINDOW_MS, 60000), // 1 minute
    requestIdPattern: /^[a-zA-Z0-9_-]+$/,
    requestIdMaxLength: 100,
  },

  // MCP connections
  mcp: {
    connections: parseJsonEnv<Record<string, any>>(
      process.env.MCP_CONNECTIONS,
      {}
    ),
  },
} as const;

/**
 * Validation results
 */
interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate configuration and return validation results
 */
export function validateConfig(): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // API key can be loaded from database at runtime, so this is just a warning
  if (!config.agent.apiKey) {
    warnings.push(
      'ANTHROPIC_API_KEY env var is not set - will be loaded from database at runtime'
    );
  }

  // Warnings for optional but recommended fields
  if (!config.supabase.url) {
    warnings.push(
      'SUPABASE_URL is not set - database operations will be disabled'
    );
  }

  if (!config.supabase.serviceKey) {
    warnings.push(
      'SUPABASE_SERVICE_KEY is not set - database operations will be disabled'
    );
  }

  if (Object.keys(config.mcp.connections).length === 0) {
    warnings.push(
      'MCP_CONNECTIONS is not set - agent will have no tools available'
    );
  }

  // Validate numeric ranges
  if (config.server.port < 1 || config.server.port > 65535) {
    errors.push(`PORT must be between 1 and 65535 (got ${config.server.port})`);
  }

  if (config.request.timeoutMs < 1000) {
    warnings.push(
      `REQUEST_TIMEOUT_MS is very low (${config.request.timeoutMs}ms) - requests may timeout too quickly`
    );
  }

  if (config.agent.timeoutMs < 1000) {
    warnings.push(
      `AGENT_TIMEOUT_MS is very low (${config.agent.timeoutMs}ms) - agent execution may timeout too quickly`
    );
  }

  if (config.files.maxSizeMb > 100) {
    warnings.push(
      `MAX_FILE_SIZE_MB is very high (${config.files.maxSizeMb}MB) - may cause memory issues`
    );
  }

  if (config.security.rateLimitMax < 1) {
    errors.push(
      `RATE_LIMIT_MAX must be at least 1 (got ${config.security.rateLimitMax})`
    );
  }

  if (config.security.rateLimitWindowMs < 1000) {
    warnings.push(
      `RATE_LIMIT_WINDOW_MS is very low (${config.security.rateLimitWindowMs}ms)`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Log configuration validation results
 * Call this at application startup
 */
export function logConfigValidation(): void {
  console.log('[Config] Validating configuration...');

  const result = validateConfig();

  // Log configuration summary
  console.log('[Config] Server configuration:');
  console.log(`[Config]   - Port: ${config.server.port}`);
  console.log(`[Config]   - Environment: ${config.server.nodeEnv}`);
  console.log(`[Config]   - CORS Origin: ${config.server.corsOrigin}`);

  console.log('[Config] Agent configuration:');
  console.log(
    `[Config]   - API Key: ${config.agent.apiKey ? 'SET' : 'NOT SET'}`
  );
  console.log(`[Config]   - Model: ${config.agent.model}`);
  console.log(
    `[Config]   - Timeout: ${config.agent.timeoutMs / 1000}s`
  );
  console.log(
    `[Config]   - Disallowed Tools: ${config.agent.disallowedTools.length > 0 ? config.agent.disallowedTools.join(', ') : 'none'}`
  );

  console.log('[Config] Workflow configuration:');
  console.log(`[Config]   - Agent Model: ${config.workflow.agentModel}`);
  console.log(`[Config]   - Classifier Model: ${config.workflow.classifierModel}`);

  console.log('[Config] Supabase configuration:');
  console.log(
    `[Config]   - URL: ${config.supabase.url ? 'SET' : 'NOT SET'}`
  );
  console.log(
    `[Config]   - Service Key: ${config.supabase.serviceKey ? 'SET' : 'NOT SET'}`
  );
  console.log(`[Config]   - Storage Bucket: ${config.supabase.storageBucket}`);

  console.log('[Config] File configuration:');
  console.log(`[Config]   - Max Size: ${config.files.maxSizeMb}MB`);

  console.log('[Config] Security configuration:');
  console.log(`[Config]   - Rate Limit: ${config.security.rateLimitMax} requests per ${config.security.rateLimitWindowMs / 1000}s`);

  console.log('[Config] MCP configuration:');
  const mcpServers = Object.keys(config.mcp.connections);
  console.log(
    `[Config]   - Servers: ${mcpServers.length > 0 ? mcpServers.join(', ') : 'none'}`
  );

  // Log errors
  if (result.errors.length > 0) {
    console.error('[Config] Configuration ERRORS:');
    result.errors.forEach((error) => console.error(`[Config]   ❌ ${error}`));
  }

  // Log warnings
  if (result.warnings.length > 0) {
    console.warn('[Config] Configuration WARNINGS:');
    result.warnings.forEach((warning) =>
      console.warn(`[Config]   ⚠️  ${warning}`)
    );
  }

  // Log result
  if (result.valid) {
    console.log('[Config] ✓ Configuration validation passed');
  } else {
    console.error(
      '[Config] ✗ Configuration validation failed - see errors above'
    );
  }

  console.log('[Config] ========================================\n');
}

/**
 * Get configuration value by path (for runtime access)
 * Example: getConfig('agent.model') returns 'claude-sonnet-4-20250514'
 */
export function getConfig(path: string): any {
  const parts = path.split('.');
  let value: any = config;

  for (const part of parts) {
    if (value && typeof value === 'object' && part in value) {
      value = value[part];
    } else {
      return undefined;
    }
  }

  return value;
}

/**
 * Check if required configuration is present for a feature
 */
export const featureFlags = {
  hasDatabase: (): boolean => {
    return !!(config.supabase.url && config.supabase.serviceKey);
  },

  hasAgent: (): boolean => {
    return !!config.agent.apiKey;
  },

  hasMcpTools: (): boolean => {
    return Object.keys(config.mcp.connections).length > 0;
  },
} as const;
