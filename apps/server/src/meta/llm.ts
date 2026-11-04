import OpenAI from 'openai';
import { config } from '../config.ts';

// Muse Spark through the Meta Model API's OpenAI-compatible chat completions endpoint.

export type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Billable tokens; `output` includes hidden reasoning, `cachedInput` is part of `input`. */
export interface LlmUsage {
  input: number;
  cachedInput: number;
  output: number;
}

export interface LlmResult {
  id?: string;
  content: string;
  toolCalls: LlmToolCall[];
  /** Absent for models that cost nothing (the demo model, test fakes). */
  usage?: LlmUsage;
}

export interface SearchRequest {
  instructions: string;
  input: string;
  location?: { city?: string; country?: string; timezone?: string };
}

export interface SearchResult {
  text: string;
  /** Every URL the search actually returned or opened: answers may only cite these. */
  sources: string[];
  usage?: LlmUsage;
}

export interface Llm {
  complete(req: { messages: ChatMessage[]; tools: ToolSpec[]; maxTokens?: number }): Promise<LlmResult>;
  /** Grounded web search; absent on models without it (demo model, test fakes). */
  search?(req: SearchRequest): Promise<SearchResult>;
}

export class MetaLlm implements Llm {
  private client: OpenAI;

  constructor(
    private model = config.META_LLM_MODEL,
    apiKey = config.META_API_KEY,
    /** The eval pins temperature 0 (the API accepts it, Oct 31); production leaves the model's default. */
    private opts: { temperature?: number } = {},
  ) {
    if (!apiKey) throw new Error('META_API_KEY is not set');
    this.client = new OpenAI({
      apiKey,
      baseURL: config.META_BASE_URL,
      timeout: config.LLM_TIMEOUT_MS,
      maxRetries: 2,
    });
  }

  // The budget covers hidden reasoning too: at 600 it was all spent thinking, leaving no answer.
  async complete({ messages, tools, maxTokens = 4000 }: Parameters<Llm['complete']>[0]): Promise<LlmResult> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      messages,
      max_completion_tokens: maxTokens,
      reasoning_effort: config.META_REASONING_EFFORT as never,
      // Routes our requests (which share the system-prompt prefix) to the same cache.
      prompt_cache_key: 'ipersons-agent',
      ...(this.opts.temperature !== undefined ? { temperature: this.opts.temperature } : {}),
      ...(tools.length
        ? { tools: tools.map((t) => ({ type: 'function' as const, function: t })) }
        : {}),
    });
    const msg = res.choices[0]?.message;
    return {
      id: res.id,
      usage: res.usage && {
        input: res.usage.prompt_tokens,
        cachedInput: res.usage.prompt_tokens_details?.cached_tokens ?? 0,
        output: res.usage.completion_tokens,
      },
      content: msg?.content ?? '',
      toolCalls: (msg?.tool_calls ?? []).flatMap((c) =>
        c.type === 'function' ? [{ id: c.id, name: c.function.name, arguments: c.function.arguments }] : [],
      ),
    };
  }

  /**
   * Muse Spark with built-in web search (Responses API only). Unbounded, it opened page after page
   * (~120k input tokens, ~$0.10); capping tool calls and answering from snippets keeps it near 9k (~$0.01).
   */
  async search({ instructions, input, location }: SearchRequest): Promise<SearchResult> {
    const res = await this.client.responses.create({
      model: this.model,
      instructions,
      input,
      tools: [{ type: 'web_search', search_context_size: 'low', user_location: { type: 'approximate', ...location } } as never],
      include: ['web_search_call.results'] as never,
      reasoning: { effort: config.META_REASONING_EFFORT as never },
      max_tool_calls: 3,
      max_output_tokens: 4000,
      prompt_cache_key: 'ipersons-search',
    } as never) as unknown as {
      output: { type: string; action?: { url?: string }; results?: { url?: string }[]; content?: { text?: string; annotations?: { url?: string }[] }[] }[];
      usage?: { input_tokens: number; output_tokens: number; input_tokens_details?: { cached_tokens?: number } };
    };
    const sources = new Set<string>();
    let text = '';
    for (const o of res.output) {
      if (o.action?.url) sources.add(o.action.url);
      for (const r of o.results ?? []) if (r.url) sources.add(r.url);
      for (const c of o.content ?? []) {
        if (o.type === 'message' && c.text) text = c.text; // the final message is the answer
        for (const a of c.annotations ?? []) if (a.url) sources.add(a.url);
      }
    }
    return {
      text,
      sources: [...sources],
      usage: res.usage && { input: res.usage.input_tokens, cachedInput: res.usage.input_tokens_details?.cached_tokens ?? 0, output: res.usage.output_tokens },
    };
  }
}
