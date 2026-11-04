import type { Risk } from '@ipersons/shared';
import { z } from 'zod';
import type { Db } from '../../db/client.ts';
import type { Llm, ToolSpec } from '../../meta/llm.ts';

export interface ToolContext {
  db: Db;
  /** For tools that need a sub-call to the model (find_opportunities). */
  llm: Llm;
  ipersonId: string;
  userName: string;
  timezone: string;
  now: Date;
  /** Message the owner on their own verified WhatsApp number; undefined if not linked or not configured. */
  whatsappOwner?: (text: string, image?: { data: Buffer; mime: string }) => Promise<void>;
  /** Outside sources (web search, emails, MCP…) the model has read in this turn or the one before. */
  influence?: () => string[];
  /** DEMO: a demo account (users.account_kind 'demo'): hand-offs go to the neutral demo services, no real brands. */
  demo?: boolean;
  /** Called when a fact or rule is held for the user's keep (it was learned after reading outside content). */
  onPendingMemory?: (item: PendingMemory) => void;
}

/** A fact or rule waiting for the user's Keep / Discard. */
export interface PendingMemory { kind: 'fact' | 'rule'; id: string; text: string; source: string }

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  risk: Risk;
  schema: S;
  /** Pre-built JSON schema for the model (MCP tools); otherwise derived from `schema`. */
  jsonSchema?: Record<string, unknown>;
  /** One line shown on the confirm card, e.g. "Book Yoga, Tue 4 Nov 18:00". Write/money tools. */
  summarize?(args: z.infer<S>, ctx: ToolContext): string;
  /** Amount a money tool will spend; checked against the wallet before it runs. */
  amount?(args: z.infer<S>): { cents: number; currency: string };
  execute(ctx: ToolContext, args: z.infer<S>): Promise<unknown>;
  /** Fills in arguments from what the twin knows before a proposal is made (e.g. learned hotel preferences). */
  prepare?(ctx: ToolContext, args: z.infer<S>): Promise<z.infer<S>>;
  /** Brings outside content into the conversation (e.g. "web search", "mcp:booking"): results are wrapped as untrusted. */
  external?: string;
  /** DEMO: the source name on demo accounts, when it differs there (find_offers reads the demo services' listings). */
  demoExternal?: string;
  /**
   * Checked before a write/money proposal is created and again before it runs: a string is a refusal
   * the model passes on (limits, verification), so no card is shown for something that can't happen.
   */
  check?(ctx: ToolContext, args: z.infer<S>): Promise<string | null>;
  /**
   * Runs only through an approval card created by the system (e.g. a partner's request). Never offered
   * to the model, and a model call to it is refused as an unknown tool.
   */
  internal?: boolean;
}

export function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool;
}

export function toToolSpec(tool: Tool): ToolSpec {
  const { $schema: _, ...parameters } = tool.jsonSchema ?? (z.toJSONSchema(tool.schema, { io: 'input' }) as Record<string, unknown>);
  return { name: tool.name, description: `[${tool.risk}] ${tool.description}`, parameters };
}
