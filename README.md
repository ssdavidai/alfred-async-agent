# Async Agent

A generic async agent server using Claude Agent SDK with dynamic MCP connections.

## Features

- **Claude Agent SDK Integration**: Execute prompts with full agent capabilities
- **Dynamic MCP Connections**: MCP server configurations are provided per-request via middleware
- **Async Execution**: Support for both synchronous and asynchronous request processing
- **File Handling**: Automatic detection and upload of generated files to Supabase Storage
- **Result Persistence**: Store agent results in Supabase for later retrieval
- **Production Ready**: Rate limiting, security headers, error handling, logging, metrics

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment configuration
cp .env.example .env

# Edit .env with your configuration
# At minimum, set ANTHROPIC_API_KEY

# Run in development mode
npm run dev

# Or build and run production
npm run build
npm start
```

## API Endpoints

### POST /webhook (or /webhooks/prompt)

Execute a prompt through the agent.

**Request Body:**
```json
{
  "prompt": "Your prompt here",
  "requestId": "optional-request-id",
  "systemPrompt": "optional system prompt override",
  "async": false,
  "metadata": {}
}
```

**Response:**
```json
{
  "response": "Agent's response",
  "files": [
    { "name": "file.txt", "url": "https://..." }
  ],
  "requestId": "req-123",
  "trace": []
}
```

### GET /health

Health check endpoint.

### GET /metrics

Server metrics endpoint.

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | - | PostgreSQL connection string |
| `ANTHROPIC_API_KEY` | Yes | - | Anthropic API key |
| `PORT` | No | 3001 | Server port |
| `AGENT_MODEL` | No | claude-sonnet-4-20250514 | Claude model to use |
| `AGENT_TIMEOUT_MS` | No | 300000 | Agent execution timeout (ms) |
| `SUPABASE_URL` | No | - | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | No | - | Supabase service key |
| `MCP_CONNECTIONS` | No | {} | JSON-encoded MCP server configurations |

See `.env.example` for all options.

### Database Client

Async Agent uses a Prisma-based database client with connection pooling optimized for single-tenant VM workloads.

#### Connection Pool Settings

- **Pool Size**: 5 connections (single-tenant, lower concurrency)
- **Connection Timeout**: 5 seconds
- **Query Timeout**: 15 seconds (allows for complex workflow queries)

#### Database Configuration

```bash
DATABASE_URL="postgresql://user:password@localhost:5432/async_agent?schema=public&connection_limit=5"
```

#### Usage Examples

**Basic Usage:**

```typescript
import prisma from './src/db/client';

// Query skills
const skills = await prisma.skill.findMany({
  where: { isActive: true },
});

// Get skill with connections
const skill = await prisma.skill.findUnique({
  where: { id: skillId },
  include: { connections: true },
});
```

**Health Check:**

```typescript
import { healthCheck } from './src/db/client';

const isHealthy = await healthCheck();
```

**Transactions for Skill Execution:**

```typescript
import { transaction } from './src/db/client';

const execution = await transaction(async (tx) => {
  // Create execution record
  const exec = await tx.execution.create({
    data: {
      skillId,
      status: 'running',
      trigger: 'manual',
    },
  });

  // Update skill metadata
  await tx.skill.update({
    where: { id: skillId },
    data: {
      runCount: { increment: 1 },
      lastRunAt: new Date(),
    },
  });

  return exec;
});
```

**Skill Execution Helpers:**

```typescript
import { createSkillExecution, completeSkillExecution } from './src/db/utils';

// Start execution (atomic with skill update)
const execution = await createSkillExecution('skill-123', {
  trigger: 'webhook',
  input: { data: 'test' },
});

// Complete execution
await completeSkillExecution(execution.id, {
  status: 'completed',
  output: 'Success',
  trace: { steps: [] },
  durationMs: 1500,
  tokenCount: 250,
  costUsd: 0.01,
});
```

#### Database Schema

The Prisma schema is located at `prisma/schema.prisma`. Key entities:

- **Connection** - MCP connections with encrypted credentials
- **Skill** - User workflows with steps and trigger configuration
- **Execution** - Full execution history with traces
- **Config** - Encrypted key-value store for VM secrets

#### Migrations

Apply database migrations:

```bash
npx prisma migrate deploy
```

Generate Prisma client after schema changes:

```bash
npx prisma generate
```

### Prompts

System and user prompts can be configured via:

1. **Environment variables**: `SYSTEM_PROMPT`, `USER_PROMPT_PREFIX`
2. **Files**: `prompts/system.md`, `prompts/user.md`

## MCP Connections

The key feature of this server is **dynamic MCP connections**. Instead of hardcoding MCP server configurations, they're provided per-request via the connections middleware.

### Default: Environment Variable

By default, MCP connections are loaded from the `MCP_CONNECTIONS` environment variable:

```bash
MCP_CONNECTIONS='{"my-server":{"command":"node","args":["server.js"]}}'
```

### Custom: Implement Your Own Middleware

For dynamic connections (e.g., per-tenant, per-user), replace the middleware in `src/index.ts`:

```typescript
import { connectionsMiddleware } from './middleware/connections.js';

// Replace this:
app.use(createEnvConnectionsMiddleware());

// With your custom middleware:
app.use(async (req, res, next) => {
  const tenantId = req.headers['x-tenant-id'];
  const connections = await myConnectionService.getConnections(tenantId);
  req.mcpConnections = connections;
  next();
});
```

### MCP Connection Format

```typescript
interface McpServerConfig {
  command: string;      // Command to start the MCP server
  args: string[];       // Command arguments
  env?: Record<string, string>;  // Environment variables
}

interface McpConnections {
  [serverName: string]: McpServerConfig;
}
```

Example:
```json
{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@anthropic/mcp-server-filesystem", "/path/to/dir"]
  },
  "github": {
    "command": "node",
    "args": ["./mcp/github-server.js"],
    "env": {
      "GITHUB_TOKEN": "ghp_..."
    }
  }
}
```

## Project Structure

```
async-agent/
├── src/
│   ├── index.ts              # Main server entry point
│   ├── webhook.ts            # Webhook handler
│   ├── agent.ts              # Claude Agent SDK integration
│   ├── types.ts              # TypeScript types
│   ├── validation.ts         # Request validation (Zod)
│   ├── database.ts           # Supabase database operations
│   ├── files.ts              # File detection and upload
│   ├── prompts.ts            # Prompt loading
│   ├── middleware/
│   │   ├── connections.ts    # MCP connections middleware
│   │   ├── logging.ts        # Request logging
│   │   ├── timeout.ts        # Request timeout
│   │   ├── security.ts       # Security validation
│   │   └── error-handler.ts  # Error handling
│   └── utils/
│       ├── errors.ts         # Custom error classes
│       └── monitoring.ts     # Metrics collection
├── prompts/
│   ├── system.md             # Default system prompt
│   └── user.md               # Default user prompt prefix
├── package.json
├── tsconfig.json
└── .env.example
```

## Development

```bash
# Run in development mode with hot reload
npm run dev

# Type check without building
npm run typecheck

# Build for production
npm run build

# Run production build
npm start
```

## Database Schema

If using Supabase for result persistence, create this table:

```sql
CREATE TABLE results (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  request_id TEXT NOT NULL,
  text TEXT NOT NULL,
  files JSONB DEFAULT '[]',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_results_request_id ON results(request_id);
```

## Storage Bucket

If using Supabase Storage for file uploads:

1. Create a bucket named `agent-files` (or set `SUPABASE_STORAGE_BUCKET`)
2. Configure public access if you want files to be publicly accessible

## License

MIT
