/**
 * Compatibility layer for converting MCP (Model Context Protocol) tools
 * to OpenAI tools/functions format and vice versa.
 *
 * This module provides utilities to bridge MCP tool definitions and calls
 * with OpenAI's tool/function calling API, enabling seamless integration
 * for future OpenAI provider implementation.
 */

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
