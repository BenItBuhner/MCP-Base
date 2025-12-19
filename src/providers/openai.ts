import OpenAI from "openai";
import {
  convertMCPToolsToOpenAITools,
  convertOpenAIToolCallToMCPToolCall,
  convertToolResultToOpenAIToolResult,
  MCPTool,
} from "../mcp-to-openai";
import dotenv from "dotenv";

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
