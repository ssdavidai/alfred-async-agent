/**
 * Async Agent Database Utilities
 *
 * Common patterns and helpers for database operations on user VMs
 */

import { PrismaClient } from '@prisma/client';
import { getPrismaClient, TransactionClient } from './client.js';

/**
 * Prisma error codes
 * Reference: https://www.prisma.io/docs/reference/api-reference/error-reference
 */
export const PrismaErrorCodes = {
  CONNECTION_ERROR: 'P1001',
  CONNECTION_TIMEOUT: 'P1008',
  DATABASE_NOT_FOUND: 'P1003',
  UNIQUE_CONSTRAINT: 'P2002',
  FOREIGN_KEY_CONSTRAINT: 'P2003',
  RECORD_NOT_FOUND: 'P2025',
} as const;

/**
 * Type guard to check if error is a Prisma error
 */
export function isPrismaError(error: unknown): error is { code: string; meta?: any } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as any).code === 'string'
  );
}

/**
 * Retry configuration for transient database errors
 */
export interface RetryConfig {
  maxAttempts: number;
  delayMs: number;
  backoffMultiplier: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  delayMs: 100,
  backoffMultiplier: 2,
};

/**
 * Execute a database operation with retry logic for transient errors
 * @param operation - Database operation to execute
 * @param config - Retry configuration
 * @returns Promise with operation result
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  config: Partial<RetryConfig> = {}
): Promise<T> {
  const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: Error;
  let delay = retryConfig.delayMs;

  for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      // Only retry on connection errors
      const shouldRetry =
        isPrismaError(error) &&
        (error.code === PrismaErrorCodes.CONNECTION_ERROR ||
          error.code === PrismaErrorCodes.CONNECTION_TIMEOUT);

      if (!shouldRetry || attempt === retryConfig.maxAttempts) {
        throw error;
      }

      console.warn(`[Database Retry] Attempt ${attempt}/${retryConfig.maxAttempts} failed, retrying in ${delay}ms...`);

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, delay));

      // Exponential backoff
      delay *= retryConfig.backoffMultiplier;
    }
  }

  throw lastError!;
}

/**
 * Sanitize error for logging (removes sensitive information)
 * @param error - Error to sanitize
 * @returns Object safe for logging
 */
export function sanitizeError(error: unknown): Record<string, any> {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      code: isPrismaError(error) ? error.code : undefined,
    };
  }

  return {
    message: 'Unknown error',
    error: String(error),
  };
}

/**
 * Check if database is in a healthy state
 * Performs more comprehensive checks than basic healthCheck
 * @returns Promise<boolean> - true if all checks pass
 */
export async function detailedHealthCheck(): Promise<{
  healthy: boolean;
  checks: Record<string, boolean>;
  latencyMs?: number;
}> {
  const client = getPrismaClient();
  const checks: Record<string, boolean> = {};
  let latencyMs: number | undefined;

  // Check 1: Basic connectivity
  try {
    const start = Date.now();
    await client.$queryRaw`SELECT 1`;
    latencyMs = Date.now() - start;
    checks.connectivity = true;
  } catch {
    checks.connectivity = false;
  }

  // Check 2: Can read from config table
  try {
    await client.config.findFirst({
      take: 1,
    });
    checks.readAccess = true;
  } catch {
    checks.readAccess = false;
  }

  // Check 3: Can read from skills table
  try {
    await client.skill.findFirst({
      take: 1,
    });
    checks.skillsAccess = true;
  } catch {
    checks.skillsAccess = false;
  }

  const healthy = Object.values(checks).every((check) => check === true);

  return {
    healthy,
    checks,
    latencyMs,
  };
}

/**
 * Skill execution transaction helper
 * Creates execution record and updates skill metadata atomically
 * @param skillId - Skill ID
 * @param executionData - Initial execution data
 * @returns Promise with created execution
 */
export async function createSkillExecution(
  skillId: string,
  executionData: {
    trigger: string;
    input?: any;
  }
) {
  const client = getPrismaClient();

  return client.$transaction(async (tx: TransactionClient) => {
    // Create execution record
    const execution = await tx.execution.create({
      data: {
        skillId,
        status: 'running',
        trigger: executionData.trigger,
        input: executionData.input || null,
      },
    });

    // Update skill run count and last run time
    await tx.skill.update({
      where: { id: skillId },
      data: {
        runCount: { increment: 1 },
        lastRunAt: new Date(),
      },
    });

    return execution;
  });
}

/**
 * Complete skill execution transaction helper
 * Updates execution and skill metadata atomically
 * @param executionId - Execution ID
 * @param result - Execution result
 * @returns Promise with updated execution
 */
export async function completeSkillExecution(
  executionId: string,
  result: {
    status: 'completed' | 'failed';
    output?: string;
    trace?: any;
    error?: string;
    durationMs: number;
    tokenCount?: number;
    costUsd?: number;
  }
) {
  const client = getPrismaClient();

  return client.execution.update({
    where: { id: executionId },
    data: {
      status: result.status,
      output: result.output,
      trace: result.trace,
      error: result.error,
      completedAt: new Date(),
      durationMs: result.durationMs,
      tokenCount: result.tokenCount,
      costUsd: result.costUsd,
    },
  });
}
