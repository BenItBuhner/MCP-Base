import { Anthropic } from "@anthropic-ai/sdk";
import {
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import dotenv from "dotenv";

// Load environment variables
dotenv.config({ path: ".env" });

// Required Anthropic configuration
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL;

if (!ANTHROPIC_API_KEY || !ANTHROPIC_BASE_URL || !ANTHROPIC_MODEL) {
  console.error(
    "Missing required environment variables. Please set ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, and ANTHROPIC_MODEL.",
  );
  throw new Error(
    "ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, or ANTHROPIC_MODEL is not set",
  );
}

/**
 * AnthropicProvider class that handles Anthropic API interactions
 */
export class AnthropicProvider {
  private anthropic: Anthropic;

  constructor() {
    this.anthropic = new Anthropic({
      apiKey: ANTHROPIC_API_KEY!,
      baseURL: ANTHROPIC_BASE_URL!,
    });
  }

  /**
   * Process a user query with multi-turn tool execution, using a provided tool executor
   */
  async processQuery(
    query: string,
    tools: Tool[],
    toolExecutor: (name: string, args: Record<string, unknown>) => Promise<any>,
  ): Promise<string> {
    const messages: MessageParam[] = [
      {
        role: "user",
        content: query,
      },
    ];

    const finalText: string[] = [];

    while (true) {
      const response = await this.anthropic.messages.create({
        model: ANTHROPIC_MODEL!,
        max_tokens: 1000,
        messages,
        tools: tools,
      });

      // Defensive check for valid response
      if (!response?.content || !Array.isArray(response.content)) {
        console.error("Empty or malformed model response:", response);
        break;
      }

      // Add assistant response to history
      messages.push({
        role: "assistant",
        content: response.content as any,
      });

      let hasToolUse = false;
      const toolResults: Array<{
        type: string;
        tool_use_id?: string;
        content: string;
      }> = [];

      // Process each content block
      for (const content of response.content) {
        if (content.type === "text") {
          finalText.push(content.text);
        } else if (content.type === "tool_use") {
          hasToolUse = true;
          const toolName = content.name;
          const toolArgs = content.input as Record<string, unknown> | undefined;

          console.log(`[Executing tool: ${toolName}]`);

          // Execute tool via provided executor
          const result = await toolExecutor(toolName, toolArgs || {});

          finalText.push(
            `[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`,
          );

          // Format result content as string
          const resultContent =
            typeof result?.content === "string"
              ? result.content
              : JSON.stringify(result?.content ?? result);

          toolResults.push({
            type: "tool_result",
            tool_use_id: content.id,
            content: resultContent,
          });
        } else {
          finalText.push(
            `[Unknown content type from model: ${JSON.stringify(content)}]`,
          );
        }
      }

      // If no tool use, we're done
      if (!hasToolUse) {
        break;
      }

      // Add tool results for next turn
      messages.push({
        role: "user",
        content: toolResults as any,
      });
    }

    return finalText.join("\n");
  }
}
