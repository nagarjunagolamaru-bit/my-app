export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
}

export interface ChatRequest {
  message: string;
  thread_id?: number;
}

export interface ChatResponse {
  reply: string;
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
