import OpenAI from "openai";
import dotenv from "dotenv";

// Type definitions for MCP tools (based on MCP SDK)
export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>; // JSON Schema
}

// Type definitions for OpenAI tools
export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>; // JSON Schema
  };
}

// Type definitions for OpenAI tool calls
export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

// Type definitions for MCP tool calls (based on usage in anthropic.ts)
export interface MCPToolCall {
  name: string;
  arguments: Record<string, any>;
}

// Type definitions for tool results
export interface ToolResult {
  content: any;
}

/**
 * Converts an MCP tool to an OpenAI tool format
 */
export function convertMCPToolToOpenAITool(mcpTool: MCPTool): OpenAITool {
  return {
    type: "function",
    function: {
      name: mcpTool.name,
      description: mcpTool.description,
      parameters: mcpTool.inputSchema,
    },
  };
}

/**
 * Converts an array of MCP tools to OpenAI tools format
 */
export function convertMCPToolsToOpenAITools(
  mcpTools: MCPTool[],
): OpenAITool[] {
  return mcpTools.map(convertMCPToolToOpenAITool);
}

/**
 * Converts an OpenAI tool call to MCP tool call format
 */
export function convertOpenAIToolCallToMCPToolCall(
  openAIToolCall: OpenAIToolCall,
): MCPToolCall {
  return {
    name: openAIToolCall.function.name,
    arguments: JSON.parse(openAIToolCall.function.arguments),
  };
}

/**
 * Converts MCP tool call to OpenAI tool call format
 */
export function convertMCPToolCallToOpenAIToolCall(
  mcpToolCall: MCPToolCall,
  toolCallId: string,
): OpenAIToolCall {
  return {
    id: toolCallId,
    type: "function",
    function: {
      name: mcpToolCall.name,
      arguments: JSON.stringify(mcpToolCall.arguments),
    },
  };
}

/**
 * Converts a tool result to OpenAI tool result format
 * (OpenAI expects tool results in the message content)
 */
export function convertToolResultToOpenAIToolResult(
  result: ToolResult,
  toolCallId: string,
): {
  tool_call_id: string;
  content: string;
} {
  return {
    tool_call_id: toolCallId,
    content:
      typeof result.content === "string"
        ? result.content
        : JSON.stringify(result.content),
  };
}

/**
 * Converts OpenAI tool result to MCP tool result format
 */
export function convertOpenAIToolResultToToolResult(openAIToolResult: {
  tool_call_id: string;
  content: string;
}): ToolResult & { tool_call_id: string } {
  return {
    tool_call_id: openAIToolResult.tool_call_id,
    content: openAIToolResult.content,
  };
}

// Load environment variables
dotenv.config({ path: ".env" });

// Required OpenAI configuration
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4";

if (!OPENAI_API_KEY) {
  console.error(
    "Missing required environment variables. Please set OPENAI_API_KEY.",
  );
  throw new Error("OPENAI_API_KEY is not set");
}

/**
 * OpenAIProvider class that handles OpenAI API interactions
 */
export class OpenAIProvider {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({
      apiKey: OPENAI_API_KEY!,
      baseURL: OPENAI_BASE_URL,
    });
  }

  /**
   * Process a user query with multi-turn tool execution, using a provided tool executor
   */
  async processQuery(
    query: string,
    mcpTools: MCPTool[],
    toolExecutor: (name: string, args: Record<string, unknown>) => Promise<any>,
  ): Promise<string> {
    const openaiTools = convertMCPToolsToOpenAITools(mcpTools);

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: "user",
        content: query,
      },
    ];

    const finalText: string[] = [];

    while (true) {
      const response = await this.openai.chat.completions.create({
        model: OPENAI_MODEL!,
        messages,
        tools: openaiTools.length > 0 ? openaiTools : undefined,
      });

      // Defensive check for valid response
      if (!response?.choices || response.choices.length === 0) {
        console.error("Empty or malformed model response:", response);
        break;
      }

      const message = response.choices[0].message;

      // Add assistant response to history
      messages.push(message);

      // Collect text content
      if (message.content) {
        finalText.push(message.content);
      }

      // Check for tool calls
      if (!message.tool_calls || message.tool_calls.length === 0) {
        break;
      }

      // Process tool calls
      for (const toolCall of message.tool_calls) {
        // Only handle function tool calls
        if (toolCall.type !== "function") {
          console.log(`Skipping non-function tool call: ${toolCall.type}`);
          continue;
        }

        const mcpCall = convertOpenAIToolCallToMCPToolCall({
          id: toolCall.id,
          type: toolCall.type,
          function: toolCall.function,
        });

        console.log(`[Executing tool: ${mcpCall.name}]`);

        // Execute tool via provided executor
        const result = await toolExecutor(mcpCall.name, mcpCall.arguments);

        finalText.push(
          `[Calling tool ${mcpCall.name} with args ${JSON.stringify(mcpCall.arguments)}]`,
        );

        // Convert result to OpenAI tool message format
        const toolResult = convertToolResultToOpenAIToolResult(
          result,
          toolCall.id,
        );

        // Add tool result as a tool message
        messages.push({
          role: "tool",
          content: toolResult.content,
          tool_call_id: toolCall.id,
        });
      }
    }

    return finalText.join("\n");
  }
}
