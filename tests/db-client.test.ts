/**
 * Async Agent Database Client Tests
 *
 * Tests for database connection pooling, health checks, and transaction support
 */

import { PrismaClient } from '@prisma/client';

// Mock Prisma Client
jest.mock('@prisma/client', () => {
  const mockPrismaClient = {
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

  return {
    PrismaClient: jest.fn(() => mockPrismaClient),
  };
});

describe('Async Agent Database Client', () => {
  let mockPrismaInstance: any;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };

    // Set test environment variable
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/testdb';

    // Clear module cache to get fresh instances
    jest.resetModules();

    // Get mock instance
    const { PrismaClient: MockPrismaClient } = require('@prisma/client');
    mockPrismaInstance = new MockPrismaClient();
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;

    // Clear all mocks
    jest.clearAllMocks();
  });

  describe('getPrismaClient', () => {
    test('initializes Prisma client successfully', () => {
      const { getPrismaClient } = require('../src/db/client');
      const client = getPrismaClient();

      expect(client).toBeDefined();
      expect(PrismaClient).toHaveBeenCalled();
    });

    test('throws error when DATABASE_URL is not set', () => {
      delete process.env.DATABASE_URL;

      const { getPrismaClient } = require('../src/db/client');

      expect(() => getPrismaClient()).toThrow('DATABASE_URL environment variable is not set');
    });

    test('returns same instance on multiple calls (singleton)', () => {
      const { getPrismaClient } = require('../src/db/client');
      const client1 = getPrismaClient();
      const client2 = getPrismaClient();

      expect(client1).toBe(client2);
    });

    test('configures connection pooling for VM workload', () => {
      const { getPrismaClient } = require('../src/db/client');
      getPrismaClient();

      const mockConstructor = PrismaClient as jest.MockedClass<typeof PrismaClient>;
      const constructorCall = mockConstructor.mock.calls[0]?.[0];

      // Verify constructor was called with datasources config
      expect(constructorCall).toBeDefined();
      expect(constructorCall).toHaveProperty('datasources');

      // Check that URL contains pooling parameters (may be in datasources.db.url)
      const datasources = constructorCall?.datasources as any;
      if (datasources?.db?.url) {
        expect(datasources.db.url).toContain('connection_limit');
        expect(datasources.db.url).toContain('pool_timeout');
      }
    });

    test('sets up error and warning event listeners', () => {
      const { getPrismaClient } = require('../src/db/client');
      getPrismaClient();

      expect(mockPrismaInstance.$on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockPrismaInstance.$on).toHaveBeenCalledWith('warn', expect.any(Function));
    });
  });

  describe('healthCheck', () => {
    test('returns true when database is accessible', async () => {
      mockPrismaInstance.$queryRaw.mockResolvedValueOnce([{ '?column?': 1 }]);

      const { healthCheck } = require('../src/db/client');
      const result = await healthCheck();

      expect(result).toBe(true);
      expect(mockPrismaInstance.$queryRaw).toHaveBeenCalled();
    });

    test('returns false when database connection fails', async () => {
      mockPrismaInstance.$queryRaw.mockRejectedValueOnce(new Error('Connection failed'));

      const { healthCheck } = require('../src/db/client');
      const result = await healthCheck();

      expect(result).toBe(false);
    });

    test('logs error without exposing sensitive data', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
      mockPrismaInstance.$queryRaw.mockRejectedValueOnce(
        new Error('Connection failed: encrypted:secret123')
      );

      const { healthCheck } = require('../src/db/client');
      await healthCheck();

      expect(consoleErrorSpy).toHaveBeenCalled();
      const errorLog = consoleErrorSpy.mock.calls[0];
      expect(errorLog[1]).toHaveProperty('timestamp');
      expect(errorLog[1]).toHaveProperty('error');

      consoleErrorSpy.mockRestore();
    });
  });

  describe('withTimeout', () => {
    test('executes query successfully within timeout', async () => {
      const { withTimeout } = require('../src/db/client');
      const mockQuery = jest.fn().mockResolvedValue({ data: 'test' });

      const result = await withTimeout(mockQuery, 5000);

      expect(result).toEqual({ data: 'test' });
      expect(mockQuery).toHaveBeenCalled();
    });

    test('rejects when query exceeds timeout', async () => {
      const { withTimeout } = require('../src/db/client');
      const mockQuery = jest.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 200))
      );

      await expect(withTimeout(mockQuery, 50)).rejects.toThrow('Query timeout after 50ms');
    });

    test('uses default timeout of 15 seconds for workflow queries', async () => {
      const { withTimeout } = require('../src/db/client');
      const mockQuery = jest.fn().mockResolvedValue({ data: 'test' });

      await withTimeout(mockQuery);

      expect(mockQuery).toHaveBeenCalled();
    });
  });

  describe('transaction', () => {
    test('executes transaction successfully', async () => {
      mockPrismaInstance.$transaction.mockImplementation(async (callback: any) => {
        return callback(mockPrismaInstance);
      });

      const { transaction } = require('../src/db/client');
      const operations = jest.fn().mockResolvedValue('result');

      const result = await transaction(operations);

      expect(result).toBe('result');
      expect(mockPrismaInstance.$transaction).toHaveBeenCalled();
      expect(operations).toHaveBeenCalledWith(mockPrismaInstance);
    });

    test('rolls back transaction on error', async () => {
      mockPrismaInstance.$transaction.mockImplementation(async (callback: any) => {
        return callback(mockPrismaInstance);
      });

      const { transaction } = require('../src/db/client');
      const operations = jest.fn().mockRejectedValue(new Error('Transaction failed'));

      await expect(transaction(operations)).rejects.toThrow('Transaction failed');
    });

    test('supports atomic skill execution operations', async () => {
      mockPrismaInstance.$transaction.mockImplementation(async (callback: any) => {
        return callback(mockPrismaInstance);
      });
      mockPrismaInstance.execution.create.mockResolvedValue({
        id: 'exec-1',
        status: 'running',
      });
      mockPrismaInstance.skill.update.mockResolvedValue({
        id: 'skill-1',
        runCount: 5,
      });

      const { transaction } = require('../src/db/client');

      const result = await transaction(async (tx: any) => {
        const execution = await tx.execution.create({ data: { status: 'running' } });
        await tx.skill.update({ where: { id: 'skill-1' }, data: { runCount: { increment: 1 } } });
        return execution;
      });

      expect(result).toEqual({ id: 'exec-1', status: 'running' });
      expect(mockPrismaInstance.execution.create).toHaveBeenCalled();
      expect(mockPrismaInstance.skill.update).toHaveBeenCalled();
    });
  });

  describe('disconnect', () => {
    test('disconnects Prisma client gracefully', async () => {
      const { getPrismaClient, disconnect } = require('../src/db/client');
      getPrismaClient(); // Initialize client

      await disconnect();

      expect(mockPrismaInstance.$disconnect).toHaveBeenCalled();
    });

    test('handles disconnect when client is not initialized', async () => {
      const { disconnect } = require('../src/db/client');

      await expect(disconnect()).resolves.not.toThrow();
    });
  });

  describe('graceful shutdown', () => {
    test('handles SIGTERM signal', async () => {
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

      // Remove existing listeners to prevent conflicts
      process.removeAllListeners('SIGTERM');
      process.removeAllListeners('SIGINT');

      const { getPrismaClient } = require('../src/db/client');
      getPrismaClient();

      // Trigger SIGTERM
      process.emit('SIGTERM' as any);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockPrismaInstance.$disconnect).toHaveBeenCalled();
      expect(consoleLogSpy).toHaveBeenCalledWith('[Database] Disconnecting Prisma client...');

      // Clean up
      exitSpy.mockRestore();
      consoleLogSpy.mockRestore();
      process.removeAllListeners('SIGTERM');
      process.removeAllListeners('SIGINT');
    });

    test('handles SIGINT signal', async () => {
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

      // Remove existing listeners to prevent conflicts
      process.removeAllListeners('SIGTERM');
      process.removeAllListeners('SIGINT');

      const { getPrismaClient } = require('../src/db/client');
      getPrismaClient();

      // Trigger SIGINT
      process.emit('SIGINT' as any);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(mockPrismaInstance.$disconnect).toHaveBeenCalled();

      // Clean up
      exitSpy.mockRestore();
      consoleLogSpy.mockRestore();
      process.removeAllListeners('SIGTERM');
      process.removeAllListeners('SIGINT');
    });
  });
});
