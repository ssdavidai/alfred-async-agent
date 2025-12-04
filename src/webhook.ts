/**
 * Webhook Handler
 *
 * Processes incoming prompts through the agent pipeline:
 * Request → Validation → Agent Execution → File Processing → Response
 */

import { Request, Response } from 'express';
import { webhookRequestSchema } from './validation.js';
import { executeAgent } from './agent.js';
import {
  detectFiles,
  uploadAllFiles,
  cleanupWorkingDirectory,
} from './files.js';
import { upsertResult, createExecution, updateExecution } from './database.js';
import { AgentError, ValidationError } from './utils/errors.js';
import { logger, getCorrelationId } from './middleware/logging.js';
import { metrics } from './utils/monitoring.js';
import { loadSystemPrompt, loadUserPromptPrefix } from './prompts.js';
import { WebhookResponse, ClassificationResult } from './types.js';
import { classifyWorkflow } from './workflow-classifier.js';
import { executeWorkflowOrchestrator } from './workflow-orchestrator.js';

/**
 * Format uploaded files as text to append to agent response
 */
function formatFilesForResponse(files: any[]): string {
  if (files.length === 0) return '';

  const fileList = files
    .map((file, index) => {
      return `${index + 1}. ${file.name}\n   URL: ${file.url}`;
    })
    .join('\n');

  return `\n\n--- Files Generated ---\n${fileList}`;
}

/**
 * Main webhook handler
 */
export async function webhookHandler(req: Request, res: Response) {
  const startTime = Date.now();
  const correlationId = getCorrelationId(req);

  try {
    // Step 1: Validate request
    logger.info(correlationId, 'webhook', 'Validating request');
    const validation = webhookRequestSchema.safeParse(req.body);

    if (!validation.success) {
      throw new ValidationError(
        'Invalid request body',
        new Error(JSON.stringify(validation.error.errors))
      );
    }

    const {
      prompt,
      requestId: providedRequestId,
      systemPrompt: requestSystemPrompt,
      async: isAsync,
      searchWorkflow,
      metadata,
    } = validation.data;

    // Generate request ID if not provided
    const requestId = providedRequestId || `req-${Date.now()}`;

    // If async=true, respond immediately and continue in background
    if (isAsync) {
      logger.info(
        correlationId,
        'webhook',
        'Async mode enabled - responding immediately'
      );
      res.status(202).json({ status: 'processing', requestId });

      // Continue execution in background
      processWebhookAsync(
        req,
        prompt,
        requestId,
        requestSystemPrompt,
        searchWorkflow,
        metadata,
        correlationId,
        startTime
      ).catch((error) => {
        logger.error(correlationId, 'webhook-async', 'Background execution failed', {
          error: error.message,
          name: error.name,
        });
        metrics.recordRequest(false, Date.now() - startTime);
        metrics.recordError(error.name || 'UnknownError');
      });

      return;
    }

    // Synchronous mode - execute and wait for completion
    logger.info(correlationId, 'webhook', `Processing request: ${requestId}`);

    const response = await processWebhook(
      req,
      prompt,
      requestId,
      requestSystemPrompt,
      searchWorkflow,
      metadata,
      correlationId,
      startTime
    );

    res.json(response);
  } catch (error: any) {
    logger.error(correlationId, 'webhook', 'Request failed', {
      error: error.message,
      name: error.name,
    });

    metrics.recordRequest(false, Date.now() - startTime);
    metrics.recordError(error.name || 'UnknownError');

    throw error;
  }
}

/**
 * Process webhook request - returns response object
 */
async function processWebhook(
  req: Request,
  prompt: string,
  requestId: string,
  requestSystemPrompt: string | undefined,
  searchWorkflow: boolean,
  metadata: Record<string, any> | undefined,
  correlationId: string,
  startTime: number
): Promise<WebhookResponse> {
  let workingDirectory: string | null = null;
  let executionId: string | null = null;

  try {
    // Get MCP connections from request (set by connections middleware)
    const mcpConnections = req.mcpConnections || {};

    if (Object.keys(mcpConnections).length === 0) {
      logger.warn(
        correlationId,
        'webhook',
        'No MCP connections available - agent will have no tools'
      );
    } else {
      logger.info(
        correlationId,
        'webhook',
        `Using MCP connections: ${Object.keys(mcpConnections).join(', ')}`
      );
    }

    // Load prompts
    const systemPrompt = requestSystemPrompt || (await loadSystemPrompt());
    const userPromptPrefix = await loadUserPromptPrefix();

    // Classify workflow (if enabled)
    let classification: ClassificationResult = {
      workflowId: null,
      workflowData: null,
      confidence: 'none',
    };

    if (searchWorkflow) {
      logger.info(correlationId, 'classifier', 'Classifying workflow');

      try {
        classification = await classifyWorkflow(prompt);

        if (classification.workflowId && classification.workflowData) {
          logger.info(
            correlationId,
            'classifier',
            `Matched workflow: ${classification.workflowData.name} (${classification.workflowData.steps.length} steps, confidence: ${classification.confidence})`
          );
        } else {
          logger.info(correlationId, 'classifier', 'No workflow match - using one-off agent');
        }
      } catch (error: any) {
        logger.warn(
          correlationId,
          'classifier',
          `Classification failed: ${error.message}. Falling back to one-off agent.`
        );
      }
    } else {
      logger.info(correlationId, 'classifier', 'Workflow search disabled');
    }

    // Execute agent (or workflow orchestrator)
    logger.info(correlationId, 'agent', 'Starting agent execution');

    let agentResponse: string;
    let conversationTrace: any[] | undefined;

    // Create execution record if skill was matched
    if (classification.workflowId && classification.workflowData) {
      try {
        executionId = await createExecution({
          skillId: classification.workflowId,
          requestId,
          trigger: 'webhook',
          input: { prompt, metadata, requestId },
        });
        logger.info(correlationId, 'execution', `Created execution ${executionId}`);
      } catch (error: any) {
        logger.warn(correlationId, 'execution', `Failed to create execution: ${error.message}`);
        // Non-fatal - continue execution
      }
    }

    try {
      // Branch based on classification
      if (classification.workflowId && classification.workflowData) {
        // WORKFLOW ORCHESTRATION
        logger.info(
          correlationId,
          'orchestrator',
          `Executing ${classification.workflowData.steps.length}-step workflow`
        );

        const agentResult = await executeWorkflowOrchestrator(
          classification.workflowData,
          prompt,
          requestId,
          mcpConnections,
          systemPrompt
        );

        agentResponse = agentResult.text;
        workingDirectory = agentResult.workingDirectory;
        conversationTrace = agentResult.trace;
      } else {
        // ONE-OFF AGENT
        const agentResult = await executeAgent({
          prompt,
          requestId,
          mcpConnections,
          systemPrompt,
          userPromptPrefix: userPromptPrefix || undefined,
        });

        agentResponse = agentResult.text;
        workingDirectory = agentResult.workingDirectory;
        conversationTrace = agentResult.trace;
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      logger.info(
        correlationId,
        'agent',
        `Agent execution completed (duration: ${duration}s)`
      );
    } catch (error: any) {
      if (error.message?.includes('timeout')) {
        throw new AgentError('Agent execution timeout', error);
      }
      throw new AgentError('Agent execution failed', error);
    }

    // Process files
    logger.info(correlationId, 'files', 'Processing generated files');
    let uploadedFiles: any[] = [];

    try {
      if (workingDirectory) {
        const detectedFiles = await detectFiles(workingDirectory);

        if (detectedFiles.length > 0) {
          logger.info(
            correlationId,
            'files',
            `Detected ${detectedFiles.length} files`
          );
          metrics.recordFileGenerated();

          uploadedFiles = await uploadAllFiles(detectedFiles, requestId);

          if (uploadedFiles.length > 0) {
            logger.info(
              correlationId,
              'files',
              `Successfully uploaded ${uploadedFiles.length}/${detectedFiles.length} files`
            );
            uploadedFiles.forEach(() => metrics.recordFileUploaded());
          }
        } else {
          logger.info(correlationId, 'files', 'No files detected');
        }
      }
    } catch (error: any) {
      // File processing is non-fatal
      logger.error(correlationId, 'files', 'File processing error (non-fatal)', {
        error: error.message,
      });
      metrics.recordError('StorageError');
    }

    // Append file information to response text
    if (uploadedFiles.length > 0) {
      agentResponse += formatFilesForResponse(uploadedFiles);
      logger.info(
        correlationId,
        'files',
        `Appended ${uploadedFiles.length} file(s) to response text`
      );
    }

    // Store result in database and update execution
    logger.info(correlationId, 'database', 'Storing result');

    try {
      await upsertResult({
        requestId,
        text: agentResponse,
        files: uploadedFiles,
        metadata: { ...metadata, executionId },
      });
      logger.info(correlationId, 'database', 'Result stored successfully');

      // Update execution record with success
      if (executionId) {
        const durationMs = Date.now() - startTime;
        await updateExecution(executionId, {
          status: 'completed',
          output: agentResponse,
          trace: conversationTrace,
          durationMs,
        });
        logger.info(correlationId, 'execution', `Execution ${executionId} completed`);
      }
    } catch (error: any) {
      // Database failure is non-fatal
      logger.error(correlationId, 'database', 'Database upsert error (non-fatal)', {
        error: error.message,
      });
      metrics.recordError('DatabaseError');
    }

    // Cleanup working directory
    if (workingDirectory) {
      cleanupWorkingDirectory(workingDirectory).catch((error) => {
        logger.warn(correlationId, 'cleanup', 'Cleanup warning (non-fatal)', {
          error: error.message,
        });
      });
    }

    // Build and send response
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    logger.info(
      correlationId,
      'webhook',
      `Request completed successfully (duration: ${duration}s)`
    );

    metrics.recordRequest(true, Date.now() - startTime);

    // Build response with workflow info if applicable
    const response: WebhookResponse = {
      response: agentResponse,
      files: uploadedFiles,
      requestId,
      trace: conversationTrace,
    };

    if (classification.workflowId && classification.workflowData) {
      response.workflowId = classification.workflowId;
      response.workflow = classification.workflowData;
    }

    return response;
  } catch (error: any) {
    logger.error(correlationId, 'webhook', 'Request failed', {
      error: error.message,
      name: error.name,
    });

    metrics.recordRequest(false, Date.now() - startTime);
    metrics.recordError(error.name || 'UnknownError');

    // Update execution with failure if we have an execution ID
    if (executionId) {
      const durationMs = Date.now() - startTime;
      await updateExecution(executionId, {
        status: 'failed',
        error: error.message,
        durationMs,
      }).catch((updateErr) => {
        logger.warn(correlationId, 'execution', `Failed to update execution on error: ${updateErr.message}`);
      });
    }

    if (workingDirectory) {
      cleanupWorkingDirectory(workingDirectory).catch((cleanupErr) => {
        logger.warn(correlationId, 'cleanup', 'Cleanup error during error handling', {
          error: cleanupErr.message,
        });
      });
    }

    throw error;
  }
}

/**
 * Process webhook request asynchronously (fire and forget)
 */
async function processWebhookAsync(
  req: Request,
  prompt: string,
  requestId: string,
  requestSystemPrompt: string | undefined,
  searchWorkflow: boolean,
  metadata: Record<string, any> | undefined,
  correlationId: string,
  startTime: number
): Promise<void> {
  try {
    await processWebhook(
      req,
      prompt,
      requestId,
      requestSystemPrompt,
      searchWorkflow,
      metadata,
      correlationId,
      startTime
    );
  } catch (error: any) {
    logger.error(correlationId, 'webhook-async', 'Async processing failed', {
      error: error.message,
      name: error.name,
    });
    throw error;
  }
}
