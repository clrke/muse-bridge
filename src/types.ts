/** One chat message a client may pass along as context (accepted, currently unused by project turns). */
export interface ParsedMessage {
  sender: string;
  message: string;
  timestamp: string | null;
  replyTo: string | null;
  type: 'text' | 'sticker' | 'photo';
  receivedAt?: number;
}

export interface Trigger {
  type: 'inline' | 'reply';
  query: string | null;
  /** Who sent the message. Optional; defaults to the bridge's configured sender name. */
  sender?: string;
  replyTo: string | null;
  /** The command line, e.g. `/my-project add a jump button` or `/list`. */
  originalMessage: string;
}

export interface AskPayload {
  trigger: Trigger;
  recentMessages: ParsedMessage[];
  repliedToMessage: ParsedMessage | null;
  chatId?: string;
}

/** Body for POST /notify: pushes a message to every /events subscriber, tagged with a project. */
export interface NotifyPayload {
  slug: string;
  message: string;
}

export interface AskResponse {
  response: string;
  timestamp: string;
  toolsUsed?: string[];
}

export interface HealthResponse {
  status: 'ok';
  timestamp: string;
  uptime: number;
  stats: {
    requestsServed: number;
    avgResponseMs: number;
    lastError: string | null;
  };
}

export interface ProjectConfig {
  title: string;
  slug: string;
  description: string;
  /** Absolute path of the workspace Muse runs in. */
  directory: string;
  /** Muse session id (`muse exec --session-id`), null until the first turn. */
  sessionId: string | null;
  status: string;
  decision: {
    summary: string;
    rating: number;
    deadline: string;
    pausedRemaining: number | null;
  } | null;
  /** Let the hourly cron answer this project's pending decision once its deadline passes. */
  autoDecide: boolean;
  createdAt: string;
  lastConversationAt?: string;
  /** Last time a client (not the cron) messaged this project. */
  lastUserMessageAt?: string;
}

export interface ProjectResponse {
  tldr: string;
  /** Optional secondary findings/details separate from the core tldr (wire field: other_findings). */
  otherFindings?: string;
  /** Optional list of assumptions made while answering (wire field: assumptions_made). */
  assumptionsMade?: string;
  decision: { summary: string; rating: number } | null;
}
