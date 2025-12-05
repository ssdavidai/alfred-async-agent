/**
 * Agent Execution Module
 *
 * Executes prompts using Claude Agent SDK with MCP tools.
 * MCP connections are passed in dynamically rather than loaded from config.
 */

import fs from 'fs/promises';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AgentResponse, McpConnections } from './types.js';
import { config } from './config/index.js';
import { getAnthropicApiKey } from './config.js';
import {
  extractResponseText,
  getDefaultSystemPrompt,
  logAgentMessage,
} from './shared/agent-utils.js';

export interface ExecuteAgentOptions {
  /** User's prompt */
  prompt: string;

  /** Unique request identifier for working directory */
  requestId: string;

  /** MCP server connections to use */
  mcpConnections: McpConnections;

  /** Optional system prompt */
  systemPrompt?: string;

  /** Optional user prompt prefix (prepended to prompt) */
  userPromptPrefix?: string;
}

/**
 * Execute Claude Agent SDK to process a prompt
 *
 * @param options - Agent execution options
 * @returns Agent response with text and working directory path
 */
export async function executeAgent(
  options: ExecuteAgentOptions
): Promise<AgentResponse> {
  const { prompt, requestId, mcpConnections, systemPrompt, userPromptPrefix } =
    options;

  const timestamp = Date.now();
  const workingDirectory = `/tmp/${requestId}-${timestamp}`;

  try {
    // Fetch API key from database at runtime
    const apiKey = await getAnthropicApiKey();
    if (!apiKey) {
      throw new Error('Anthropic API key not configured. Please set up your API key in the configuration.');
    }
    // Set API key in environment for Claude Agent SDK
    process.env.ANTHROPIC_API_KEY = apiKey;
    console.log(`[Agent] API key loaded from database`);

    // Create unique working directory
    await fs.mkdir(workingDirectory, { recursive: true });
    console.log(`[Agent] Created working directory: ${workingDirectory}`);

    // Construct final prompts
    const finalSystemPrompt = systemPrompt || getDefaultSystemPrompt();
    const finalUserPrompt = userPromptPrefix
      ? `${userPromptPrefix}\n\n${prompt}`
      : prompt;

    console.log(`[Agent] ========================================`);
    console.log(`[Agent] Starting execution for requestId: ${requestId}`);
    console.log(`[Agent] Working directory: ${workingDirectory}`);
    console.log(`[Agent] Model: ${config.agent.model}`);
    console.log(
      `[Agent] Disallowed tools: ${config.agent.disallowedTools.length > 0 ? config.agent.disallowedTools.join(', ') : 'none'}`
    );
    console.log(
      `[Agent] MCP Servers configured: ${Object.keys(mcpConnections).join(', ') || 'none'}`
    );
    console.log(
      `[Agent] User Prompt: "${prompt.substring(0, 200)}${prompt.length > 200 ? '...' : ''}"`
    );
    console.log(`[Agent] ========================================`);

    // Execute Claude Agent SDK with MCP tools
    const queryInstance = query({
      prompt: finalUserPrompt,
      options: {
        model: config.agent.model,
        systemPrompt: finalSystemPrompt,
        mcpServers: mcpConnections,
        cwd: workingDirectory,
        permissionMode: 'bypassPermissions',
        disallowedTools:
          config.agent.disallowedTools.length > 0
            ? config.agent.disallowedTools
            : undefined,
      },
    });

    // Iterate through all messages and collect the final result
    let finalResult: any = null;
    let messageCount = 0;
    const conversationTrace: any[] = [];

    const executionPromise = (async () => {
      for await (const message of queryInstance) {
        messageCount++;
        conversationTrace.push(message);

        // Log different message types
        logAgentMessage(message, messageCount);

        if (message.type === 'result') {
          finalResult = message;
        }
      }
      return finalResult;
    })();

    const result = await Promise.race([
      executionPromise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Agent execution timeout')),
          config.agent.timeoutMs
        )
      ),
    ]);

    console.log(`\n[Agent] ========================================`);
    console.log(`[Agent] Completed execution for requestId: ${requestId}`);
    console.log(`[Agent]    Total messages processed: ${messageCount}`);
    console.log(`[Agent] ========================================\n`);

    // Extract text from result
    const responseText = extractResponseText(result);

    return {
      text: responseText,
      workingDirectory: workingDirectory,
      trace: conversationTrace,
    };
  } catch (error) {
    console.error(`[Agent] Error for requestId ${requestId}:`, error);

    if (error instanceof Error) {
      throw new Error(`Agent execution failed: ${error.message}`);
    }

    throw new Error('Agent execution failed');
  }
}

