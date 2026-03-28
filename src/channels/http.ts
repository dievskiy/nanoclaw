import fs from 'fs';
import http from 'http';
import path from 'path';

import { ASSISTANT_NAME, DEFAULT_TRIGGER, GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import { Channel, NewMessage, RegisteredGroup } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const DEFAULT_PORT = 3001;

interface FieldUpdates {
  customer_id?: string;
  site_id?: string;
  service_category?: string;
  description?: string;
  hours?: number;
  date?: string;
  materials?: unknown[];
  compliance_flags?: unknown[];
  approval_notes?: string;
  certification_verified?: boolean;
}

interface SectionsToShow {
  showMaterials?: boolean;
  showCompliance?: boolean;
  showApproval?: boolean;
  showCertification?: boolean;
}

interface AgentResponse {
  text: string;
  fieldUpdates?: FieldUpdates;
  sectionsToShow?: SectionsToShow;
}

interface SessionState {
  buffer: string[];
  fieldUpdates: FieldUpdates;
  sectionsToShow: SectionsToShow;
  resolve: ((response: AgentResponse) => void) | null;
}

// Appended to global/CLAUDE.md for ui-W groups.
// Tells the agent to embed structured UI updates in <internal> JSON blocks
// without changing its conversational output.
const UI_WORKER_APPEND = `

## UI Channel Instructions (ui-W groups only)

You are responding via the web UI channel. In addition to your conversational reply, embed structured form updates in an \`<internal>\` JSON block:

\`\`\`
<internal>{"fieldUpdates": {"field": "value"}, "sectionsToShow": {"showSection": true}}</internal>
\`\`\`

Available \`fieldUpdates\` keys: \`customer_id\`, \`site_id\`, \`service_category\`, \`description\`, \`hours\`, \`date\`, \`materials\`, \`compliance_flags\`, \`approval_notes\`, \`certification_verified\`.

Available \`sectionsToShow\` keys: \`showMaterials\`, \`showCompliance\`, \`showApproval\`, \`showCertification\`.

Rules:
- Only include keys you are setting or revealing. Omit keys you are not changing.
- Never set a section to false — omit it instead.
- Other \`<internal>\` blocks used for reasoning are fine; they will not be confused with this.
`;

export class HttpChannel implements Channel {
  name = 'http';

  private server: http.Server | null = null;
  private opts: ChannelOpts;
  private port: number;
  private sessions = new Map<string, SessionState>();

  constructor(opts: ChannelOpts, port: number) {
    this.opts = opts;
    this.port = port;
  }

  async connect(): Promise<void> {
    this.server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }

      if (req.method === 'POST' && req.url === '/message') {
        this.handleMessage(req, res);
      } else {
        res.writeHead(404).end('Not found');
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.port, '127.0.0.1', () => {
        logger.info({ port: this.port }, 'HTTP channel listening');
        console.log(
          `\n  HTTP channel: http://localhost:${this.port}/message\n`,
        );
        resolve();
      });
      this.server!.once('error', reject);
    });
  }

  private handleMessage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let parsed: { sessionId?: string; text?: string };
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400).end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const { sessionId, text } = parsed;
      if (
        !sessionId ||
        typeof sessionId !== 'string' ||
        !text ||
        typeof text !== 'string'
      ) {
        res
          .writeHead(400)
          .end(JSON.stringify({ error: 'sessionId and text are required' }));
        return;
      }

      if (!/^ui-W-\d+$/.test(sessionId)) {
        res.writeHead(400).end(
          JSON.stringify({
            error: 'sessionId must be of the form ui-W-N (e.g. ui-W-001)',
          }),
        );
        return;
      }

      const chatJid = `http:${sessionId}`;

      if (!this.opts.registeredGroups()[chatJid]) {
        this.registerSession(chatJid, sessionId);
      }

      const timestamp = new Date().toISOString();
      this.opts.onChatMetadata(chatJid, timestamp, sessionId, 'http', false);

      const msg: NewMessage = {
        id: `${chatJid}-${Date.now()}`,
        chat_jid: chatJid,
        sender: sessionId,
        sender_name: sessionId,
        content: text,
        timestamp,
        is_from_me: false,
      };
      this.opts.onMessage(chatJid, msg);

      this.waitForResponse(chatJid)
        .then((response) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
        })
        .catch((err) => {
          logger.error({ chatJid, err }, 'HTTP response error');
          res.writeHead(500).end(JSON.stringify({ error: 'Internal error' }));
        });
    });
  }

  private registerSession(chatJid: string, sessionId: string): void {
    const groupDir = path.join(GROUPS_DIR, sessionId);
    fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

    // Write CLAUDE.md before registerGroup (which skips if file already exists).
    // Inherit the global template so all domain instructions are preserved,
    // then append the ui-W specific instructions.
    const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) {
      const globalMd = path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
      let content = fs.existsSync(globalMd)
        ? fs.readFileSync(globalMd, 'utf-8')
        : '';
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      content += UI_WORKER_APPEND;
      fs.writeFileSync(claudeMdPath, content);
    }

    const group: RegisteredGroup = {
      name: sessionId,
      folder: sessionId,
      trigger: DEFAULT_TRIGGER,
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    };
    this.opts.registerGroup(chatJid, group);
    logger.info({ chatJid, folder: sessionId }, 'HTTP session auto-registered');
  }

  private waitForResponse(chatJid: string): Promise<AgentResponse> {
    return new Promise((resolve) => {
      const existing = this.sessions.get(chatJid);
      if (existing) {
        existing.resolve = resolve;
      } else {
        this.sessions.set(chatJid, {
          buffer: [],
          fieldUpdates: {},
          sectionsToShow: {},
          resolve,
        });
      }
    });
  }

  // Receives raw agent output before <internal> stripping.
  // Extracts structured UI updates from <internal> JSON blocks,
  // then strips all <internal> content and buffers the clean text.
  async sendRaw(jid: string, raw: string): Promise<void> {
    let state = this.sessions.get(jid);
    if (!state) {
      state = {
        buffer: [],
        fieldUpdates: {},
        sectionsToShow: {},
        resolve: null,
      };
      this.sessions.set(jid, state);
    }

    const internalRe = /<internal>([\s\S]*?)<\/internal>/g;
    let match: RegExpExecArray | null;
    while ((match = internalRe.exec(raw)) !== null) {
      try {
        const parsed = JSON.parse(match[1].trim());
        if (parsed && typeof parsed === 'object') {
          if (parsed.fieldUpdates && typeof parsed.fieldUpdates === 'object') {
            Object.assign(state.fieldUpdates, parsed.fieldUpdates);
          }
          if (
            parsed.sectionsToShow &&
            typeof parsed.sectionsToShow === 'object'
          ) {
            Object.assign(state.sectionsToShow, parsed.sectionsToShow);
          }
        }
      } catch {
        // Plain reasoning block, not structured data — skip
      }
    }

    const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
    if (text) state.buffer.push(text);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Fallback path — called only if sendRaw is somehow bypassed
    const state = this.sessions.get(jid);
    if (!state) {
      this.sessions.set(jid, {
        buffer: [text],
        fieldUpdates: {},
        sectionsToShow: {},
        resolve: null,
      });
    } else {
      state.buffer.push(text);
    }
  }

  async agentDone(jid: string): Promise<void> {
    const state = this.sessions.get(jid);
    if (!state) return;

    const text = state.buffer.join('\n\n');
    const fieldUpdates =
      Object.keys(state.fieldUpdates).length > 0
        ? state.fieldUpdates
        : undefined;
    const sectionsToShow =
      Object.keys(state.sectionsToShow).length > 0
        ? state.sectionsToShow
        : undefined;

    state.buffer = [];
    state.fieldUpdates = {};
    state.sectionsToShow = {};

    if (state.resolve) {
      state.resolve({ text, fieldUpdates, sectionsToShow });
      state.resolve = null;
    }
  }

  isConnected(): boolean {
    return this.server !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('http:');
  }

  async disconnect(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
      logger.info('HTTP channel stopped');
    }
  }
}

registerChannel('http', (opts: ChannelOpts) => {
  const port = parseInt(
    process.env.HTTP_CHANNEL_PORT || String(DEFAULT_PORT),
    10,
  );
  return new HttpChannel(opts, port);
});
