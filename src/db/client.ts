/**
 * Async Agent Database Client
 *
 * Manages Prisma client with connection pooling optimized for single-tenant VM workload.
 * Configuration:
 * - Pool size: 5 connections (single-tenant, lower concurrency)
 * - Connection timeout: 5 seconds
 * - Query timeout: 15 seconds (allows for complex workflow queries)
 *
 * SECURITY: Contains encrypted credentials - logs sanitized errors only.
 */

import { PrismaClient, Prisma } from '@prisma/client';

// Type for Prisma transaction client
export type TransactionClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

/**
 * Database client configuration
 */
const DATABASE_CONFIG = {
  CONNECTION_TIMEOUT: 5000, // 5 seconds
  QUERY_TIMEOUT: 15000, // 15 seconds (longer for workflow execution)
  POOL_SIZE: 5, // Optimized for single-tenant VM workload
};

/**
 * Singleton Prisma client instance
 */
let prismaInstance: PrismaClient | null = null;

/**
 * Initialize and return Prisma client with connection pooling
 * Implements singleton pattern to ensure single instance across application
 */
export function getPrismaClient(): PrismaClient {
  if (!prismaInstance) {
    // Validate required environment variable
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is not set');
    }

    // Parse DATABASE_URL to add connection pool parameters
    const databaseUrl = new URL(process.env.DATABASE_URL);

    // Add connection pool settings to URL if not already present
    if (!databaseUrl.searchParams.has('connection_limit')) {
      databaseUrl.searchParams.set('connection_limit', DATABASE_CONFIG.POOL_SIZE.toString());
    }
    if (!databaseUrl.searchParams.has('pool_timeout')) {
      databaseUrl.searchParams.set('pool_timeout', (DATABASE_CONFIG.CONNECTION_TIMEOUT / 1000).toString());
    }

    prismaInstance = new PrismaClient({
      datasources: {
        db: {
          url: databaseUrl.toString(),
        },
      },
      log: [
        { level: 'error', emit: 'event' },
        { level: 'warn', emit: 'event' },
      ],
    });

    // Set up error logging (without sensitive data)
    prismaInstance.$on('error' as never, (e: any) => {
      console.error('[Database Error]', {
        timestamp: new Date().toISOString(),
        message: e.message,
        target: e.target,
      });
    });

    prismaInstance.$on('warn' as never, (e: any) => {
      console.warn('[Database Warning]', {
        timestamp: new Date().toISOString(),
        message: e.message,
      });
    });

    // Handle graceful shutdown
    const shutdownHandler = async () => {
      if (prismaInstance) {
        console.log('[Database] Disconnecting Prisma client...');
        await prismaInstance.$disconnect();
        prismaInstance = null;
        console.log('[Database] Prisma client disconnected');
      }
      process.exit(0);
    };

    process.on('SIGTERM', shutdownHandler);
    process.on('SIGINT', shutdownHandler);
  }

  return prismaInstance;
}

/**
 * Health check: Verifies database connectivity
 * @returns Promise<boolean> - true if database is accessible, false otherwise
 */
export async function healthCheck(): Promise<boolean> {
  try {
    const client = getPrismaClient();
    await client.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    console.error('[Database Health Check] Failed:', {
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return false;
  }
}

/**
 * Execute a query with timeout protection
 * @param queryFn - Function that executes the Prisma query
 * @param timeoutMs - Maximum time to wait for query (default: 15 seconds)
 * @returns Promise with query result
 */
export async function withTimeout<T>(
  queryFn: () => Promise<T>,
  timeoutMs: number = DATABASE_CONFIG.QUERY_TIMEOUT
): Promise<T> {
  return Promise.race([
    queryFn(),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Query timeout after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

/**
 * Execute a database transaction
 * Useful for skill executions that require atomic operations
 * @param operations - Function that performs operations using transaction client
 * @returns Promise with transaction result
 */
export async function transaction<T>(
  operations: (tx: PrismaClient) => Promise<T>
): Promise<T> {
  const client = getPrismaClient();
  return client.$transaction(async (tx: TransactionClient) => {
    return operations(tx as PrismaClient);
  });
}

/**
 * Gracefully disconnect from database
 * Should be called during application shutdown
 */
export async function disconnect(): Promise<void> {
  if (prismaInstance) {
    await prismaInstance.$disconnect();
    prismaInstance = null;
  }
}

/**
 * Default export: Prisma client instance
 */
export default getPrismaClient();
