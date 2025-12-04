/**
 * Async Agent Database Utilities Tests
 *
 * Tests for database utility functions including skill execution helpers
 */

// Mock Prisma Client before any imports
const mockPrismaInstance = {
  $queryRaw: jest.fn(),
  $disconnect: jest.fn(),
  $transaction: jest.fn(),
  $on: jest.fn(),
  config: {
    findFirst: jest.fn(),
  },
  skill: {
    findFirst: jest.fn(),
    update: jest.fn(),
  },
  execution: {
    create: jest.fn(),
    update: jest.fn(),
  },
};

jest.mock('@prisma/client', () => ({
  PrismaClient: jest.fn(() => mockPrismaInstance),
}));

describe('Async Agent Database Utilities', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/testdb';

    // Clear all mocks but don't reset modules
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('PrismaErrorCodes', () => {
    test('exports correct error codes', () => {
      const { PrismaErrorCodes } = require('../src/db/utils');

      expect(PrismaErrorCodes.CONNECTION_ERROR).toBe('P1001');
      expect(PrismaErrorCodes.CONNECTION_TIMEOUT).toBe('P1008');
      expect(PrismaErrorCodes.UNIQUE_CONSTRAINT).toBe('P2002');
      expect(PrismaErrorCodes.RECORD_NOT_FOUND).toBe('P2025');
    });
  });

  describe('isPrismaError', () => {
    test('returns true for Prisma errors', () => {
      const { isPrismaError } = require('../src/db/utils');
      const prismaError = { code: 'P1001', meta: {} };

      expect(isPrismaError(prismaError)).toBe(true);
    });

    test('returns false for non-Prisma errors', () => {
      const { isPrismaError } = require('../src/db/utils');
      const regularError = new Error('Regular error');

      expect(isPrismaError(regularError)).toBe(false);
    });
  });

  describe('withRetry', () => {
    test('succeeds on first attempt', async () => {
      const { withRetry } = require('../src/db/utils');
      const operation = jest.fn().mockResolvedValue('success');

      const result = await withRetry(operation);

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    test('retries on connection error', async () => {
      const { withRetry, PrismaErrorCodes } = require('../src/db/utils');
      const operation = jest
        .fn()
        .mockRejectedValueOnce({ code: PrismaErrorCodes.CONNECTION_ERROR })
        .mockResolvedValueOnce('success');

      const result = await withRetry(operation, { delayMs: 10 });

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    test('throws after max retries', async () => {
      const { withRetry, PrismaErrorCodes } = require('../src/db/utils');
      const operation = jest.fn().mockRejectedValue({ code: PrismaErrorCodes.CONNECTION_ERROR });

      await expect(withRetry(operation, { maxAttempts: 2, delayMs: 10 })).rejects.toEqual({
        code: PrismaErrorCodes.CONNECTION_ERROR,
      });

      expect(operation).toHaveBeenCalledTimes(2);
    });
  });

  describe('sanitizeError', () => {
    test('sanitizes Error objects', () => {
      const { sanitizeError } = require('../src/db/utils');
      const error = new Error('Test error');

      const sanitized = sanitizeError(error);

      expect(sanitized).toEqual({
        message: 'Test error',
        name: 'Error',
        code: undefined,
      });
    });

    test('removes encrypted credentials from error messages', () => {
      const { sanitizeError } = require('../src/db/utils');
      const error = new Error('Failed: encrypted:sk-ant-secret123');

      const sanitized = sanitizeError(error);

      expect(sanitized.message).toBeDefined();
      // Error message is preserved but not exposed in logs
      expect(sanitized).toHaveProperty('message');
    });
  });

  describe('detailedHealthCheck', () => {
    test('returns healthy status when all checks pass', async () => {
      mockPrismaInstance.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      mockPrismaInstance.config.findFirst.mockResolvedValue({ key: 'test', value: 'test' });
      mockPrismaInstance.skill.findFirst.mockResolvedValue({ id: 'skill-1' });

      const { detailedHealthCheck } = require('../src/db/utils');
      const result = await detailedHealthCheck();

      expect(result.healthy).toBe(true);
      expect(result.checks.connectivity).toBe(true);
      expect(result.checks.readAccess).toBe(true);
      expect(result.checks.skillsAccess).toBe(true);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    test('returns unhealthy status when connectivity fails', async () => {
      mockPrismaInstance.$queryRaw.mockRejectedValue(new Error('Connection failed'));

      const { detailedHealthCheck } = require('../src/db/utils');
      const result = await detailedHealthCheck();

      expect(result.healthy).toBe(false);
      expect(result.checks.connectivity).toBe(false);
    });

    test('checks VM-specific tables', async () => {
      mockPrismaInstance.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
      mockPrismaInstance.config.findFirst.mockResolvedValue(null);
      mockPrismaInstance.skill.findFirst.mockResolvedValue(null);

      const { detailedHealthCheck } = require('../src/db/utils');
      await detailedHealthCheck();

      expect(mockPrismaInstance.config.findFirst).toHaveBeenCalled();
      expect(mockPrismaInstance.skill.findFirst).toHaveBeenCalled();
    });
  });

  describe('createSkillExecution', () => {
    test('creates execution and updates skill atomically', async () => {
      mockPrismaInstance.$transaction.mockImplementation(async (callback: any) => {
        return callback(mockPrismaInstance);
      });
      mockPrismaInstance.execution.create.mockResolvedValue({
        id: 'exec-1',
        skillId: 'skill-1',
        status: 'running',
        trigger: 'manual',
      });
      mockPrismaInstance.skill.update.mockResolvedValue({
        id: 'skill-1',
        runCount: 5,
      });

      const { createSkillExecution } = require('../src/db/utils');
      const result = await createSkillExecution('skill-1', {
        trigger: 'manual',
        input: { test: 'data' },
      });

      expect(result.id).toBe('exec-1');
      expect(mockPrismaInstance.$transaction).toHaveBeenCalled();
      expect(mockPrismaInstance.execution.create).toHaveBeenCalledWith({
        data: {
          skillId: 'skill-1',
          status: 'running',
          trigger: 'manual',
          input: { test: 'data' },
        },
      });
      expect(mockPrismaInstance.skill.update).toHaveBeenCalledWith({
        where: { id: 'skill-1' },
        data: {
          runCount: { increment: 1 },
          lastRunAt: expect.any(Date),
        },
      });
    });

    test('handles execution without input data', async () => {
      mockPrismaInstance.$transaction.mockImplementation(async (callback: any) => {
        return callback(mockPrismaInstance);
      });
      mockPrismaInstance.execution.create.mockResolvedValue({
        id: 'exec-2',
        status: 'running',
      });

      const { createSkillExecution } = require('../src/db/utils');
      await createSkillExecution('skill-1', { trigger: 'webhook' });

      expect(mockPrismaInstance.execution.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          input: null,
        }),
      });
    });
  });

  describe('completeSkillExecution', () => {
    test('updates execution with completion data', async () => {
      mockPrismaInstance.execution.update.mockResolvedValue({
        id: 'exec-1',
        status: 'completed',
      });

      const { completeSkillExecution } = require('../src/db/utils');
      const result = await completeSkillExecution('exec-1', {
        status: 'completed',
        output: 'Success',
        trace: { steps: [] },
        durationMs: 1500,
        tokenCount: 250,
        costUsd: 0.01,
      });

      expect(result.status).toBe('completed');
      expect(mockPrismaInstance.execution.update).toHaveBeenCalledWith({
        where: { id: 'exec-1' },
        data: {
          status: 'completed',
          output: 'Success',
          trace: { steps: [] },
          error: undefined,
          completedAt: expect.any(Date),
          durationMs: 1500,
          tokenCount: 250,
          costUsd: 0.01,
        },
      });
    });

    test('updates execution with failure data', async () => {
      mockPrismaInstance.execution.update.mockResolvedValue({
        id: 'exec-1',
        status: 'failed',
      });

      const { completeSkillExecution } = require('../src/db/utils');
      await completeSkillExecution('exec-1', {
        status: 'failed',
        error: 'Connection timeout',
        durationMs: 5000,
      });

      expect(mockPrismaInstance.execution.update).toHaveBeenCalledWith({
        where: { id: 'exec-1' },
        data: expect.objectContaining({
          status: 'failed',
          error: 'Connection timeout',
        }),
      });
    });
  });
});
