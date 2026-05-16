import {
  AuthUser,
  ChatHistoryResponse,
  GoogleAuthConfig,
  ChatResponse,
  ChatThread,
  ChatThreadsResponse,
  LoginResponse,
} from '../types';

export const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8010';

export async function fetcher<T>(
  input: RequestInfo,
  init?: RequestInit,
  accessToken?: string,
): Promise<T> {
  const url = typeof input === 'string' ? `${apiBaseUrl}${input}` : input;
  const headers = new Headers(init?.headers);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }

  const response = await fetch(url, {
    ...init,
    headers,
    credentials: 'include',
  });

  if (!response.ok) {
    const text = await response.text();
    let errorMessage = `Request failed with status ${response.status}`;

    try {
      const payload = JSON.parse(text);
      if (payload?.detail) {
        errorMessage = `${errorMessage}: ${payload.detail}`;
      } else if (payload?.message) {
        errorMessage = `${errorMessage}: ${payload.message}`;
      } else {
        errorMessage = `${errorMessage}: ${JSON.stringify(payload)}`;
      }
    } catch {
      if (text) {
        errorMessage = `${errorMessage}: ${text}`;
      }
    }

    throw new Error(errorMessage);
  }

  return (await response.json()) as T;
}

export async function login(email: string, password: string): Promise<LoginResponse> {
  return fetcher<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export async function signup(email: string, password: string): Promise<LoginResponse> {
  return fetcher<LoginResponse>('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export async function googleAuth(idToken: string): Promise<LoginResponse> {
  return fetcher<LoginResponse>('/api/auth/google', {
    method: 'POST',
    body: JSON.stringify({ id_token: idToken }),
  });
}

export async function getGoogleAuthConfig(): Promise<GoogleAuthConfig> {
  return fetcher<GoogleAuthConfig>('/api/auth/google/config', {
    method: 'GET',
  });
}

export async function getCurrentUser(accessToken: string): Promise<AuthUser> {
  return fetcher<AuthUser>('/api/auth/me', { method: 'GET' }, accessToken);
}

export async function getChats(accessToken: string): Promise<ChatHistoryResponse> {
  return fetcher<ChatHistoryResponse>('/api/chats', { method: 'GET' }, accessToken);
}

export async function getThreads(accessToken: string): Promise<ChatThreadsResponse> {
  return fetcher<ChatThreadsResponse>('/api/threads', { method: 'GET' }, accessToken);
}

export async function createThread(title: string, accessToken: string): Promise<ChatThread> {
  return fetcher<ChatThread>(
    '/api/threads',
    {
      method: 'POST',
      body: JSON.stringify({ title }),
    },
    accessToken,
  );
}

export async function updateThread(
  threadId: number,
  title: string,
  accessToken: string,
): Promise<ChatThread> {
  return fetcher<ChatThread>(
    `/api/threads/${threadId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    },
    accessToken,
  );
}

export async function deleteThread(threadId: number, accessToken: string): Promise<void> {
  await fetcher<{ ok: boolean }>(
    `/api/threads/${threadId}`,
    {
      method: 'DELETE',
    },
    accessToken,
  );
}

export async function getThreadMessages(
  threadId: number,
  accessToken: string,
): Promise<ChatHistoryResponse> {
  return fetcher<ChatHistoryResponse>(`/api/threads/${threadId}/messages`, { method: 'GET' }, accessToken);
}

export async function postChat(
  message: string,
  accessToken: string,
  threadId?: number,
): Promise<ChatResponse> {
  return fetcher<ChatResponse>(
    '/api/chat',
    {
      method: 'POST',
      body: JSON.stringify({ message, thread_id: threadId }),
    },
    accessToken,
  );
}

export const tokenStorageKey = 'amzur_chat_access_token';
