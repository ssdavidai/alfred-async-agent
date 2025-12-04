/**
 * Database Operations Module
 *
 * Handles skill/workflow fetching and execution tracking using local Prisma/Postgres.
 * Replaces external Supabase with local VM database.
 */

import { getPrismaClient, healthCheck } from './db/client.js';
import { FileMetadata, Workflow, WorkflowStep } from './types.js';

/**
 * Execution record for tracking skill runs
 */
export interface ExecutionRecord {
  skillId: string;
  requestId: string;
  status: 'running' | 'completed' | 'failed';
  trigger: 'webhook' | 'manual' | 'schedule' | 'chat';
  input?: Record<string, any>;
  output?: string;
  trace?: any[];
  files?: FileMetadata[];
  error?: string;
  durationMs?: number;
  tokenCount?: number;
}

/**
 * Create a new execution record when starting a skill run
 *
 * @param record - Initial execution data
 * @returns Created execution ID
 */
export async function createExecution(record: {
  skillId: string;
  requestId: string;
  trigger: ExecutionRecord['trigger'];
  input?: Record<string, any>;
}): Promise<string> {
  try {
    const prisma = getPrismaClient();

    const execution = await prisma.execution.create({
      data: {
        skillId: record.skillId,
        status: 'running',
        trigger: record.trigger,
        input: record.input || {},
        startedAt: new Date(),
      },
    });

    console.log(`[DB] Created execution ${execution.id} for skill ${record.skillId}`);
    return execution.id;
  } catch (error: any) {
    console.error('[DB] Failed to create execution:', error.message);
    throw error;
  }
}

/**
 * Update execution with result (success or failure)
 *
 * @param executionId - ID of the execution to update
 * @param result - Result data
 */
export async function updateExecution(
  executionId: string,
  result: {
    status: 'completed' | 'failed';
    output?: string;
    trace?: any[];
    error?: string;
    durationMs?: number;
    tokenCount?: number;
  }
): Promise<void> {
  try {
    const prisma = getPrismaClient();

    await prisma.execution.update({
      where: { id: executionId },
      data: {
        status: result.status,
        output: result.output,
        trace: result.trace,
        error: result.error,
        durationMs: result.durationMs,
        tokenCount: result.tokenCount,
        completedAt: new Date(),
      },
    });

    // Also update the skill's run count and last run time
    const execution = await prisma.execution.findUnique({
      where: { id: executionId },
      select: { skillId: true },
    });

    if (execution?.skillId) {
      await prisma.skill.update({
        where: { id: execution.skillId },
        data: {
          runCount: { increment: 1 },
          lastRunAt: new Date(),
        },
      });
    }

    console.log(`[DB] Updated execution ${executionId} with status: ${result.status}`);
  } catch (error: any) {
    console.error('[DB] Failed to update execution:', error.message);
    // Non-fatal - don't throw
  }
}

/**
 * Legacy function for compatibility - creates execution record
 * Maps old ResultRecord format to new Execution format
 *
 * @param record - Result record (legacy format)
 */
export async function upsertResult(record: {
  requestId: string;
  text: string;
  files: FileMetadata[];
  metadata?: Record<string, any>;
}): Promise<void> {
  // For one-off agents without skill matching, we log but don't create execution
  // since there's no skill to associate with
  console.log(`[DB] Result for requestId ${record.requestId}:`);
  console.log(`[DB]   - Text length: ${record.text.length} chars`);
  console.log(`[DB]   - Files count: ${record.files.length}`);

  // If metadata contains executionId, update that execution
  if (record.metadata?.executionId) {
    await updateExecution(record.metadata.executionId, {
      status: 'completed',
      output: record.text,
      durationMs: record.metadata.durationMs,
    });
  }
}

/**
 * Health check - verify database connection
 */
export async function checkDatabaseHealth(): Promise<boolean> {
  return healthCheck();
}

/**
 * Fetch all active skills as workflows
 * Skills with isActive=true are available for workflow matching
 *
 * @returns Array of skills (id, name, description only)
 */
export async function getAllWorkflows(): Promise<
  Pick<Workflow, 'id' | 'name' | 'description'>[]
> {
  try {
    const prisma = getPrismaClient();

    const skills = await prisma.skill.findMany({
      where: {
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        description: true,
      },
      orderBy: {
        name: 'asc',
      },
    });

    console.log(`[DB] Fetched ${skills.length} active skills as workflows`);

    return skills.map((skill: { id: string; name: string; description: string | null }) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description || '',
    }));
  } catch (error: any) {
    console.error('[DB] Failed to fetch skills:', error.message);
    return [];
  }
}

/**
 * Fetch skill by ID with full steps (as Workflow)
 *
 * @param id - Skill ID
 * @returns Complete workflow with steps, or null if not found
 */
export async function getWorkflowById(id: string): Promise<Workflow | null> {
  try {
    const prisma = getPrismaClient();

    const skill = await prisma.skill.findUnique({
      where: { id },
    });

    if (!skill) {
      console.log(`[DB] Skill not found: ${id}`);
      return null;
    }

    console.log(`[DB] Fetched skill: ${skill.name}`);

    // Map Skill to Workflow interface
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description || '',
      steps: (skill.steps as unknown as WorkflowStep[]) || [],
      created_at: skill.createdAt.toISOString(),
    };
  } catch (error: any) {
    console.error('[DB] Failed to fetch skill:', error.message);
    return null;
  }
}

/**
 * Get result (execution) by requestId
 * For compatibility with existing code that queries results
 *
 * @param requestId - Request identifier (stored in execution input)
 * @returns Execution data or null
 */
export async function getResult(requestId: string): Promise<{
  text: string;
  requestId: string;
  files: FileMetadata[];
  metadata?: Record<string, any>;
} | null> {
  try {
    const prisma = getPrismaClient();

    // Search executions by requestId in input JSON
    const executions = await prisma.execution.findMany({
      where: {
        input: {
          path: ['requestId'],
          equals: requestId,
        },
      },
      orderBy: {
        startedAt: 'desc',
      },
      take: 1,
    });

    if (executions.length === 0) {
      console.log(`[DB] No execution found for requestId: ${requestId}`);
      return null;
    }

    const execution = executions[0];

    return {
      text: execution.output || '',
      requestId,
      files: [], // Files not stored in executions currently
      metadata: {
        executionId: execution.id,
        skillId: execution.skillId,
        status: execution.status,
        durationMs: execution.durationMs,
      },
    };
  } catch (error: any) {
    console.error('[DB] Failed to get result:', error.message);
    return null;
  }
}

/**
 * Get execution by ID
 *
 * @param id - Execution ID
 * @returns Execution record or null
 */
export async function getExecutionById(id: string): Promise<ExecutionRecord | null> {
  try {
    const prisma = getPrismaClient();

    const execution = await prisma.execution.findUnique({
      where: { id },
    });

    if (!execution) {
      return null;
    }

    return {
      skillId: execution.skillId,
      requestId: (execution.input as any)?.requestId || id,
      status: execution.status as ExecutionRecord['status'],
      trigger: execution.trigger as ExecutionRecord['trigger'],
      input: execution.input as Record<string, any>,
      output: execution.output || undefined,
      trace: execution.trace as any[],
      error: execution.error || undefined,
      durationMs: execution.durationMs || undefined,
      tokenCount: execution.tokenCount || undefined,
    };
  } catch (error: any) {
    console.error('[DB] Failed to get execution:', error.message);
    return null;
  }
}

/**
 * List recent executions for a skill
 *
 * @param skillId - Skill ID
 * @param limit - Max number of executions to return
 * @returns Array of execution records
 */
export async function getExecutionsForSkill(
  skillId: string,
  limit: number = 10
): Promise<ExecutionRecord[]> {
  try {
    const prisma = getPrismaClient();

    const executions = await prisma.execution.findMany({
      where: { skillId },
      orderBy: { startedAt: 'desc' },
      take: limit,
    });

    return executions.map((e: {
      id: string;
      skillId: string;
      status: string;
      trigger: string;
      input: unknown;
      output: string | null;
      trace: unknown;
      error: string | null;
      durationMs: number | null;
      tokenCount: number | null;
    }) => ({
      skillId: e.skillId,
      requestId: (e.input as any)?.requestId || e.id,
      status: e.status as ExecutionRecord['status'],
      trigger: e.trigger as ExecutionRecord['trigger'],
      input: e.input as Record<string, any>,
      output: e.output || undefined,
      trace: e.trace as any[],
      error: e.error || undefined,
      durationMs: e.durationMs || undefined,
      tokenCount: e.tokenCount || undefined,
    }));
  } catch (error: any) {
    console.error('[DB] Failed to get executions:', error.message);
    return [];
  }
}
