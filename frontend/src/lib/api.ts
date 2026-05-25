import {
  AuthUser,
  ChatAttachment,
  ChatHistoryResponse,
  GeminiImageHealth,
  ChatMode,
  GoogleAuthConfig,
  ResearchDigestFinal,
  SupportNotificationEvent,
  SupportTicket,
  SupportTicketListResponse,
  SupportWorkflowHealth,
  TicTacToeDifficulty,
  TicTacToeState,
  ChatResponse,
  ChatThread,
  ChatThreadsResponse,
  LoginResponse,
} from '../types';

export const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8010';

function buildApiUrl(path: string): string {
  return `${apiBaseUrl}${path}`;
}

function stringifyDetail(detail: unknown): string {
  if (typeof detail === 'string') {
    return detail;
  }

  if (Array.isArray(detail)) {
    const formatted = detail
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }

        if (item && typeof item === 'object') {
          const record = item as { loc?: unknown; msg?: unknown; type?: unknown };
          const loc = Array.isArray(record.loc)
            ? record.loc
                .map((segment) => String(segment))
                .filter(Boolean)
                .join('.')
            : null;
          const msg = typeof record.msg === 'string' ? record.msg : null;
          const type = typeof record.type === 'string' ? record.type : null;

          if (loc && msg) {
            return `${loc}: ${msg}`;
          }
          if (msg) {
            return msg;
          }
          if (loc && type) {
            return `${loc}: ${type}`;
          }
        }

        try {
          return JSON.stringify(item);
        } catch {
          return String(item);
        }
      })
      .filter(Boolean);

    if (formatted.length > 0) {
      return formatted.join('; ');
    }
  }

  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

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
    const retryAfter = response.headers.get('Retry-After');
    let errorMessage = `Request failed with status ${response.status}`;

    try {
      const payload = JSON.parse(text);
      if (payload?.detail) {
        errorMessage = `${errorMessage}: ${stringifyDetail(payload.detail)}`;
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

    if (retryAfter && /^\d+$/.test(retryAfter)) {
      errorMessage = `${errorMessage} (Retry-After: ${retryAfter}s)`;
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

export async function clearThreadMemory(threadId: number, accessToken: string): Promise<void> {
  await fetcher<{ ok: boolean }>(
    `/api/threads/${threadId}/memory`,
    {
      method: 'DELETE',
    },
    accessToken,
  );
}

export async function getGeminiImageHealth(accessToken: string): Promise<GeminiImageHealth> {
  return fetcher<GeminiImageHealth>('/api/health/gemini-image', { method: 'GET' }, accessToken);
}

export async function postChat(
  message: string,
  accessToken: string,
  threadId?: number,
  attachmentIds: number[] = [],
  mode: ChatMode = 'chat',
  databaseUrl?: string,
  googleSheetUrl?: string,
  sheetName?: string,
): Promise<ChatResponse> {
  return fetcher<ChatResponse>(
    '/api/chat',
    {
      method: 'POST',
      body: JSON.stringify({
        message,
        thread_id: threadId,
        attachment_ids: attachmentIds,
        mode,
        database_url: databaseUrl,
        google_sheet_url: googleSheetUrl,
        sheet_name: sheetName,
      }),
    },
    accessToken,
  );
}

export async function uploadAttachment(
  threadId: number,
  file: File,
  accessToken: string,
  onProgress?: (percent: number) => void,
): Promise<ChatAttachment> {
  return await new Promise<ChatAttachment>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', buildApiUrl('/api/attachments/upload'));
    xhr.withCredentials = false;
    xhr.timeout = 60000;
    xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || !onProgress) {
        return;
      }
      const percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
      onProgress(percent);
    };

    xhr.onerror = () => {
      reject(new Error('Network error while uploading attachment.'));
    };

    xhr.ontimeout = () => {
      reject(new Error('Upload timed out. Please try again.'));
    };

    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        let detail = `Request failed with status ${xhr.status}`;
        try {
          const payload = JSON.parse(xhr.responseText);
          if (payload?.detail) {
            detail = `${detail}: ${stringifyDetail(payload.detail)}`;
          }
        } catch {
          if (xhr.responseText) {
            detail = `${detail}: ${xhr.responseText}`;
          }
        }
        reject(new Error(detail));
        return;
      }

      try {
        const payload = JSON.parse(xhr.responseText) as ChatAttachment;
        onProgress?.(100);
        resolve(payload);
      } catch {
        reject(new Error('Upload completed but the response was invalid.'));
      }
    };

    const formData = new FormData();
    formData.append('thread_id', String(threadId));
    formData.append('file', file);
    xhr.send(formData);
  });
}

export async function uploadFormulaAttachment(
  threadId: number,
  latex: string,
  accessToken: string,
): Promise<ChatAttachment> {
  return fetcher<ChatAttachment>(
    '/api/attachments/formula',
    {
      method: 'POST',
      body: JSON.stringify({ thread_id: threadId, latex }),
    },
    accessToken,
  );
}

export async function uploadCodeSnippetAttachment(
  threadId: number,
  code: string,
  accessToken: string,
  language?: string,
  title?: string,
): Promise<ChatAttachment> {
  return fetcher<ChatAttachment>(
    '/api/attachments/code',
    {
      method: 'POST',
      body: JSON.stringify({ thread_id: threadId, code, language, title }),
    },
    accessToken,
  );
}

export async function getAttachmentBlob(attachmentId: number, accessToken: string): Promise<Blob> {
  const response = await fetch(buildApiUrl(`/api/attachments/${attachmentId}/content`), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    credentials: 'include',
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Failed to fetch attachment ${attachmentId}.`);
  }

  return await response.blob();
}

export async function streamResearchDigest(
  topic: string,
  accessToken: string,
  threadId: number,
  onProgress: (message: string) => void,
): Promise<ResearchDigestFinal> {
  const response = await fetch(buildApiUrl('/api/research-digest/stream'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ topic, thread_id: threadId, max_iterations: 3 }),
  });

  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(text || `Research stream failed (${response.status}).`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let finalPayload: ResearchDigestFinal | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() || '';

    for (const chunk of chunks) {
      const lines = chunk.split('\n');
      let eventType = 'progress';
      let dataText = '';

      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataText += line.slice(5).trim();
        }
      }

      if (!dataText) {
        continue;
      }

      const payload = JSON.parse(dataText) as {
        type?: string;
        message?: string;
        topic?: string;
        digest?: string;
        papers?: ResearchDigestFinal['papers'];
      };

      if (eventType === 'error' || payload.type === 'error') {
        throw new Error(payload.message || 'Research stream failed.');
      }

      if (eventType === 'progress' || payload.type === 'progress') {
        if (payload.message) {
          onProgress(payload.message);
        }
        continue;
      }

      if (eventType === 'final' || payload.type === 'final') {
        finalPayload = {
          topic: String(payload.topic || topic),
          digest: String(payload.digest || ''),
          papers: payload.papers || [],
        };
      }
    }
  }

  if (!finalPayload) {
    throw new Error('Research stream finished without a final digest.');
  }

  return finalPayload;
}

export async function createSupportTicket(
  issueSummary: string,
  issueDescription: string,
  accessToken: string,
  threadId?: number,
): Promise<SupportTicket> {
  return fetcher<SupportTicket>(
    '/api/support/tickets',
    {
      method: 'POST',
      body: JSON.stringify({
        issue_summary: issueSummary,
        issue_description: issueDescription,
        thread_id: threadId,
      }),
    },
    accessToken,
  );
}

export async function listSupportTickets(
  accessToken: string,
  threadId?: number,
): Promise<SupportTicketListResponse> {
  const suffix = typeof threadId === 'number' ? `?thread_id=${threadId}` : '';
  return fetcher<SupportTicketListResponse>(`/api/support/tickets${suffix}`, { method: 'GET' }, accessToken);
}

export async function getSupportWorkflowHealth(accessToken: string): Promise<SupportWorkflowHealth> {
  return fetcher<SupportWorkflowHealth>('/api/support/workflow-health', { method: 'GET' }, accessToken);
}

export async function streamSupportNotifications(
  accessToken: string,
  onEvent: (event: SupportNotificationEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(buildApiUrl('/api/support/notifications/stream'), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    signal,
  });

  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(text || `Support notification stream failed (${response.status}).`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() || '';

    for (const chunk of chunks) {
      const lines = chunk.split('\n');
      let dataLine = '';

      for (const line of lines) {
        if (line.startsWith('data:')) {
          dataLine += line.slice(5).trim();
        }
      }

      if (!dataLine) {
        continue;
      }

      try {
        const payload = JSON.parse(dataLine) as SupportNotificationEvent;
        onEvent(payload);
      } catch {
        // Ignore malformed stream chunks and continue consuming.
      }
    }
  }
}

export async function startGame(
  accessToken: string,
  humanStarts = true,
  difficulty: TicTacToeDifficulty = 'hard',
): Promise<TicTacToeState> {
  return fetcher<TicTacToeState>(
    '/api/game/start',
    {
      method: 'POST',
      body: JSON.stringify({ human_starts: humanStarts, difficulty }),
    },
    accessToken,
  );
}

export async function getGameState(accessToken: string): Promise<TicTacToeState> {
  return fetcher<TicTacToeState>('/api/game/state', { method: 'GET' }, accessToken);
}

export async function makeGameMove(accessToken: string, cellIndex: number): Promise<TicTacToeState> {
  return fetcher<TicTacToeState>(
    '/api/game/move',
    {
      method: 'POST',
      body: JSON.stringify({ cell_index: cellIndex }),
    },
    accessToken,
  );
}

export async function resetGame(
  accessToken: string,
  humanStarts = true,
  difficulty: TicTacToeDifficulty = 'hard',
): Promise<TicTacToeState> {
  return fetcher<TicTacToeState>(
    '/api/game/reset',
    {
      method: 'POST',
      body: JSON.stringify({ human_starts: humanStarts, difficulty }),
    },
    accessToken,
  );
}

export const tokenStorageKey = 'amzur_chat_access_token';
