export type ChatRole = 'user' | 'assistant' | 'system';
export type AttachmentKind = 'image' | 'video' | 'document' | 'code' | 'formula';
export type ChatMode = 'chat' | 'image' | 'database' | 'spreadsheet' | 'research' | 'support';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  attachments?: ChatAttachment[];
}

export interface ChatRequest {
  message: string;
  thread_id?: number;
  attachment_ids?: number[];
  mode?: ChatMode;
  database_url?: string;
  google_sheet_url?: string;
  sheet_name?: string;
}

export interface ChatResponse {
  reply: string;
  attachments?: ChatAttachment[];
}

export interface ChatAttachment {
  id: number;
  kind: AttachmentKind;
  file_name: string | null;
  content_type: string | null;
  size_bytes: number;
  language: string | null;
  text_content: string | null;
  created_at: string;
}

export interface AuthUser {
  id: number;
  email: string;
}

export interface LoginResponse {
  access_token: string;
  token_type: 'bearer';
  user: AuthUser;
}

export interface GoogleAuthConfig {
  enabled: boolean;
  client_id: string | null;
  expected_origin?: string | null;
}

export interface StoredChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  attachments: ChatAttachment[];
}

export interface ChatHistoryResponse {
  messages: StoredChatMessage[];
}

export interface ChatThread {
  id: number;
  user_id: number;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface ChatThreadsResponse {
  threads: ChatThread[];
}

export interface GeminiImageHealth {
  ok: boolean;
  configured: boolean;
  key_format_valid: boolean;
  reachable: boolean;
  model_available: boolean;
  message: string;
}

export interface ResearchPaper {
  title: string;
  summary: string;
  url: string;
  authors: string[];
  published?: string | null;
  categories?: string[];
  score?: number;
}

export interface ResearchDigestFinal {
  topic: string;
  digest: string;
  papers: ResearchPaper[];
}

export interface SupportTicket {
  ticket_id: string;
  user_name: string;
  user_email: string;
  issue_summary: string;
  issue_description: string;
  category: string;
  priority: string;
  status: string;
  created_at: string;
  updated_at: string;
  message: string;
}

export interface SupportTicketListResponse {
  tickets: SupportTicket[];
}

export interface SupportNotificationEvent {
  event_type: string;
  ticket_id: string;
  status: string;
  message: string;
  timestamp: string;
}

export interface SupportWorkflowHealth {
  configured: boolean;
  active: boolean;
  fallback: boolean;
  email_webhook_configured: boolean;
  reachable: boolean;
  http_status?: number | null;
  webhook_url: string;
  message: string;
}

export type TicTacToeTurn = 'human' | 'ai';
export type TicTacToeStatus = 'in_progress' | 'human_won' | 'ai_won' | 'draw';
export type TicTacToeDifficulty = 'easy' | 'medium' | 'hard';

export interface TicTacToeState {
  board: string[];
  next_turn: TicTacToeTurn;
  status: TicTacToeStatus;
  difficulty: TicTacToeDifficulty;
  winner?: 'human' | 'ai' | null;
  human_symbol: 'X';
  ai_symbol: 'O';
  last_human_move?: number | null;
  last_ai_move?: number | null;
}
