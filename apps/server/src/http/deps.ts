import type { WaSender } from '../channels/whatsapp-client.ts';
import type { AgentRuntime } from '../agent/runtime.ts';
import type { Db } from '../db/client.ts';
import type { EventBus } from '../lib/bus.ts';
import type { GeoLookup } from '../geo/countries.ts';
import type { AvatarMaker } from '../meta/image.ts';
import type { MailClientFactory } from '../mail/sync.ts';
import type { McpRegistry } from '../mcp/client.ts';
import type { Llm } from '../meta/llm.ts';
import type { SttFactory } from '../meta/stt.ts';

export interface AppDeps {
  db: Db;
  llm: Llm;
  runtime: AgentRuntime;
  bus: EventBus;
  /** Undefined when realtime STT isn't available (no key); the browser then transcribes. */
  stt?: SttFactory;
  /** Muse Image + SAM; undefined in demo mode, where the selfie itself is the avatar. */
  avatar?: AvatarMaker;
  /** Undefined until WhatsApp credentials are configured. */
  wa?: WaSender;
  /** True when running without META_API_KEY on the rule-based demo model. */
  demoMode: boolean;
  /** MCP servers: users' own connections and admin MCP connectors (Phase 4b). */
  mcp: McpRegistry;
  /** Mailbox clients (Graph / Gmail with token refresh); tests inject fakes. */
  mail?: MailClientFactory;
  /** IP → ISO country (MaxMind GeoLite2 locally; null when unknown). */
  geo: GeoLookup;
  /** Charge Meta calls to users' AI credit (on whenever real Meta models are used). */
  billing: boolean;
}
