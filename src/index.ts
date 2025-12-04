/**
 * Async Agent Server
 *
 * A generic async agent server using Claude Agent SDK with dynamic MCP connections.
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import { webhookHandler } from './webhook.js';
import { getConfig, saveConfig } from './config.js';
import { loggingMiddleware } from './middleware/logging.js';
import { timeoutMiddleware } from './middleware/timeout.js';
import {
  securityMiddleware,
  securityHeadersMiddleware,
  rateLimitMiddleware,
} from './middleware/security.js';
import {
  errorHandler,
  notFoundHandler,
  asyncHandler,
} from './middleware/error-handler.js';
import { metrics, getUptimeString } from './utils/monitoring.js';
import { checkDatabaseHealth } from './database.js';
import { createEnvConnectionsMiddleware } from './middleware/connections.js';

const app = express();

// 1. CORS
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
  })
);

// 2. Security headers
app.use(securityHeadersMiddleware);

// 3. Body parser (must be before logging to read req.body)
app.use(express.json({ limit: '10mb' }));

// 4. Logging middleware
app.use(loggingMiddleware);

// 5. Timeout middleware
app.use(timeoutMiddleware);

// 6. Rate limiting
app.use(rateLimitMiddleware);

// 7. Security validation
app.use(securityMiddleware);

// 8. MCP Connections middleware
// By default, loads from MCP_CONNECTIONS env var
// Replace this with your own middleware for dynamic connections
app.use(createEnvConnectionsMiddleware());

// Routes
app.post('/webhook', asyncHandler(webhookHandler));
app.post('/webhooks/prompt', asyncHandler(webhookHandler)); // Alias

// Health check endpoint
app.get(
  '/health',
  asyncHandler(async (req: Request, res: Response) => {
    const health = metrics.getHealth();
    const dbHealthy = await checkDatabaseHealth();

    const overallHealthy = dbHealthy && health.status !== 'unhealthy';

    const response = {
      status: overallHealthy ? 'healthy' : 'unhealthy',
      uptime: getUptimeString(health.uptime),
      timestamp: health.timestamp,
      database: dbHealthy ? 'connected' : 'disconnected',
      metrics: health.metrics,
    };

    const statusCode = dbHealthy ? 200 : 503;
    res.status(statusCode).json(response);
  })
);

// Metrics endpoint
app.get(
  '/metrics',
  asyncHandler(async (req: Request, res: Response) => {
    const metricsData = metrics.getMetrics();

    res.json({
      timestamp: new Date().toISOString(),
      ...metricsData,
    });
  })
);

// Config endpoints
app.get('/api/config', asyncHandler(getConfig));
app.post('/api/config', asyncHandler(saveConfig));

// 404 handler
app.use(notFoundHandler);

// Error handler (must be last)
app.use(errorHandler);

// Start server
const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  console.log(`[Server] Async agent server listening on port ${PORT}`);
  console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`[Server] Health check: http://localhost:${PORT}/health`);
  console.log(`[Server] Metrics: http://localhost:${PORT}/metrics`);
  console.log(`[Server] Webhook: POST http://localhost:${PORT}/webhook`);
});

// Graceful shutdown
function gracefulShutdown(signal: string) {
  console.log(`\n[Server] Received ${signal}, starting graceful shutdown...`);

  server.close(() => {
    console.log('[Server] HTTP server closed');

    setTimeout(() => {
      console.log('[Server] Shutdown complete');
      process.exit(0);
    }, 5000);
  });

  setTimeout(() => {
    console.error('[Server] Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error: Error) => {
  console.error('[Server] Uncaught Exception:', error);
  console.error('[Server] Stack:', error.stack);

  setTimeout(() => {
    process.exit(1);
  }, 1000);
});

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  console.error('[Server] Unhandled Rejection at:', promise);
  console.error('[Server] Reason:', reason);
});

export default app;
