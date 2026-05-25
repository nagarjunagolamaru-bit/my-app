import { ChangeEvent, DragEvent, FormEvent, Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { renderToString as katexRenderToString } from 'katex';
import 'katex/dist/katex.min.css';
import {
  apiBaseUrl,
  clearThreadMemory,
  createThread,
  deleteThread,
  getSupportWorkflowHealth,
  getGoogleAuthConfig,
  getGeminiImageHealth,
  getCurrentUser,
  listSupportTickets,
  getThreadMessages,
  getThreads,
  login,
  postChat,
  signup,
  streamResearchDigest,
  streamSupportNotifications,
  tokenStorageKey,
  uploadAttachment,
  uploadCodeSnippetAttachment,
  uploadFormulaAttachment,
  updateThread,
} from '../../lib/api';
import { AttachmentPreview } from '../attachments';
import {
  AuthUser,
  ChatAttachment,
  ChatMessage,
  ChatMode,
  ChatThread,
  SupportNotificationEvent,
  SupportTicket,
  SupportWorkflowHealth,
} from '../../types';
import { useSupportTicketCreation } from '../../hooks';
import SupportTicketSection from './SupportTicketSection';

const initialMessages: ChatMessage[] = [
  {
    id: 'system',
    role: 'assistant',
    text: 'Welcome. Sign in with your @amzur.com email to load saved chats.',
  },
];

const newChatMessages: ChatMessage[] = [
  {
    id: 'assistant-new-chat',
    role: 'assistant',
    text: 'Started a new chat. Ask me anything.',
  },
];

const createDefaultNewChatTitle = (index: number) => `New Chat ${index}`;

const supportedFileExtensions = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.mp4',
  '.mov',
  '.avi',
  '.webm',
  '.csv',
  '.xlsx',
  '.pdf',
  '.js',
  '.ts',
  '.py',
  '.java',
  '.json',
  '.html',
  '.css',
  '.tsx',
  '.jsx',
  '.txt',
  '.md',
  '.yml',
  '.yaml',
  '.xml',
  '.sql',
];

const maxAttachmentSizeMb = 20;
const maxAttachmentBytes = maxAttachmentSizeMb * 1024 * 1024;
const databaseUrlStorageKey = 'amzur_chat_database_url';
const googleSheetUrlStorageKey = 'amzur_chat_google_sheet_url';

const normalizeLocalOriginForCompare = (origin: string): string => {
  try {
    const parsed = new URL(origin);
    const host = parsed.hostname.toLowerCase();

    if (host === 'localhost' || host === '127.0.0.1') {
      return `${parsed.protocol}//localdev:${parsed.port}`;
    }

    return `${parsed.protocol}//${host}:${parsed.port}`;
  } catch {
    return origin.trim().toLowerCase();
  }
};

type PendingAttachment = {
  localId: string;
  name: string;
  kind: ChatAttachment['kind'];
  status: 'uploading' | 'uploaded' | 'error';
  progress: number;
  error?: string;
  attachment?: ChatAttachment;
  previewUrl?: string;
};

type AssistantContentBlock =
  | { type: 'text'; value: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'section'; value: string }
  | { type: 'table'; headers: string[]; rows: string[][] }
  | { type: 'math-block'; latex: string };

function renderKatexSafe(latex: string, displayMode: boolean): string {
  try {
    return katexRenderToString(latex, { displayMode, throwOnError: false });
  } catch {
    return latex;
  }
}

function renderInlineMath(text: string): React.ReactNode[] {
  // Split on \(...\) inline and \[...\] display math
  const parts = text.split(/(\\\[.*?\\\]|\\\(.*?\\\))/gs);
  return parts.map((part, index) => {
    if (part.startsWith('\\[') && part.endsWith('\\]')) {
      const latex = part.slice(2, -2).trim();
      return (
        <span
          key={`math-display-${index}`}
          className="my-2 block overflow-x-auto"
          dangerouslySetInnerHTML={{ __html: renderKatexSafe(latex, true) }}
        />
      );
    }
    if (part.startsWith('\\(') && part.endsWith('\\)')) {
      const latex = part.slice(2, -2).trim();
      return (
        <span
          key={`math-inline-${index}`}
          dangerouslySetInnerHTML={{ __html: renderKatexSafe(latex, false) }}
        />
      );
    }
    return <Fragment key={`math-text-${index}`}>{part}</Fragment>;
  });
}

function renderInlineMarkdown(text: string): React.ReactNode[] {
  // First split on bold, then render math within each plain segment
  const boldSegments = text.split(/(\*\*[^*]+\*\*)/g);

  return boldSegments.flatMap((segment, index) => {
    if (segment.startsWith('**') && segment.endsWith('**')) {
      return [<strong key={`strong-${index}`} className="font-semibold text-slate-50">{segment.slice(2, -2)}</strong>];
    }
    // Render any inline math inside the plain text
    const mathParts = renderInlineMath(segment);
    return mathParts.map((node, mathIndex) =>
      typeof node === 'string'
        ? <Fragment key={`seg-${index}-m-${mathIndex}`}>{node}</Fragment>
        : <Fragment key={`seg-${index}-m-${mathIndex}`}>{node}</Fragment>
    );
  });
}

function parseTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(line);
}

function isTableRow(line: string): boolean {
  return line.includes('|');
}

function isUnorderedListItem(line: string): boolean {
  return /^\s*[-*]\s+/.test(line);
}

function isOrderedListItem(line: string): boolean {
  return /^\s*\d+\.\s+/.test(line);
}

function isMarkdownSectionLine(line: string): boolean {
  return /^\s*(\d+\.\s+)?\*\*.+\*\*:?\s*$/.test(line.trim());
}

function normalizeListItem(line: string): string {
  return line.replace(/^\s*([-*]|\d+\.)\s+/, '').trim();
}

function normalizeSectionLine(line: string): string {
  return line.replace(/^\s*\d+\.\s+/, '').trim();
}

function buildAssistantContentBlocks(text: string): AssistantContentBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: AssistantContentBlock[] = [];
  let textBuffer: string[] = [];

  const flushTextBuffer = () => {
    const value = textBuffer.join('\n').trim();
    if (value) {
      blocks.push({ type: 'text', value });
    }
    textBuffer = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const currentLine = lines[index];
    const nextLine = lines[index + 1];

    if (isTableRow(currentLine) && nextLine && isTableSeparator(nextLine)) {
      flushTextBuffer();

      const headers = parseTableRow(currentLine);
      const rows: string[][] = [];
      index += 2;

      while (index < lines.length && isTableRow(lines[index]) && lines[index].trim()) {
        rows.push(parseTableRow(lines[index]));
        index += 1;
      }

      blocks.push({ type: 'table', headers, rows });
      index -= 1;
      continue;
    }

    if (isMarkdownSectionLine(currentLine)) {
      flushTextBuffer();
      blocks.push({ type: 'section', value: normalizeSectionLine(currentLine) });
      continue;
    }

    // Display math block: \[ ... \] possibly spanning multiple lines
    if (currentLine.trim().startsWith('\\[')) {
      flushTextBuffer();
      const latexLines: string[] = [];
      let rest = currentLine.trim().slice(2);
      if (rest.endsWith('\\]')) {
        blocks.push({ type: 'math-block', latex: rest.slice(0, -2).trim() });
        continue;
      }
      latexLines.push(rest);
      index += 1;
      while (index < lines.length) {
        const mathLine = lines[index];
        if (mathLine.trim().endsWith('\\]')) {
          latexLines.push(mathLine.trim().slice(0, -2).trim());
          break;
        }
        latexLines.push(mathLine);
        index += 1;
      }
      blocks.push({ type: 'math-block', latex: latexLines.join('\n').trim() });
      continue;
    }

    if (isUnorderedListItem(currentLine) || isOrderedListItem(currentLine)) {
      flushTextBuffer();
      const ordered = isOrderedListItem(currentLine);
      const items: string[] = [];

      while (
        index < lines.length &&
        lines[index].trim() &&
        (ordered ? isOrderedListItem(lines[index]) : isUnorderedListItem(lines[index]))
      ) {
        items.push(normalizeListItem(lines[index]));
        index += 1;
      }

      blocks.push({ type: 'list', ordered, items });
      index -= 1;
      continue;
    }

    if (!currentLine.trim() && textBuffer[textBuffer.length - 1] === '') {
      continue;
    }

    textBuffer.push(currentLine);
  }

  flushTextBuffer();
  return blocks;
}

function AssistantMessageContent({ text }: { text: string }) {
  const blocks = buildAssistantContentBlocks(text);

  return (
    <div className="space-y-3">
      {blocks.map((block, blockIndex) => {
        if (block.type === 'table') {
          return (
            <div key={`table-${blockIndex}`} className="overflow-x-auto rounded-xl border border-slate-700">
              <table className="min-w-full border-collapse text-left text-sm text-slate-200">
                <thead className="bg-slate-800/90 text-slate-100">
                  <tr>
                    {block.headers.map((header, headerIndex) => (
                      <th key={`header-${blockIndex}-${headerIndex}`} className="border border-slate-700 px-3 py-2 font-semibold text-slate-50">
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-700/80">
                  {block.rows.map((row, rowIndex) => (
                    <tr key={`row-${blockIndex}-${rowIndex}`} className="align-top even:bg-slate-800/30">
                      {row.map((cell, cellIndex) => (
                        <td key={`cell-${blockIndex}-${rowIndex}-${cellIndex}`} className="border border-slate-700 px-3 py-2 text-slate-200">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        if (block.type === 'math-block') {
          return (
            <div
              key={`math-block-${blockIndex}`}
              className="overflow-x-auto rounded-xl bg-slate-800/60 px-4 py-3 text-sm"
              dangerouslySetInnerHTML={{ __html: renderKatexSafe(block.latex, true) }}
            />
          );
        }

        if (block.type === 'section') {
          return (
            <p key={`section-${blockIndex}`} className="text-sm font-semibold leading-7 text-slate-50">
              {renderInlineMarkdown(block.value)}
            </p>
          );
        }

        if (block.type === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul';
          return (
            <ListTag
              key={`list-${blockIndex}`}
              className={block.ordered ? 'list-decimal space-y-1 pl-5 text-sm leading-7' : 'list-disc space-y-1 pl-5 text-sm leading-7'}
            >
              {block.items.map((item, itemIndex) => (
                <li key={`list-item-${blockIndex}-${itemIndex}`}>{renderInlineMarkdown(item)}</li>
              ))}
            </ListTag>
          );
        }

        return (
          <Fragment key={`text-${blockIndex}`}>
            {block.value.split(/\n\s*\n/).map((paragraph, paragraphIndex) => (
              <p key={`paragraph-${blockIndex}-${paragraphIndex}`} className="whitespace-pre-wrap text-sm leading-7">
                {renderInlineMarkdown(paragraph)}
              </p>
            ))}
          </Fragment>
        );
      })}
    </div>
  );
}

function getFileExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.');
  if (dotIndex === -1) {
    return '';
  }
  return fileName.substring(dotIndex).toLowerCase();
}

function inferAttachmentKind(extension: string): ChatAttachment['kind'] | null {
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extension)) {
    return 'image';
  }
  if (['.mp4', '.mov', '.avi', '.webm'].includes(extension)) {
    return 'video';
  }
  if (['.csv', '.xlsx', '.pdf'].includes(extension)) {
    return 'document';
  }
  if (
    [
      '.js',
      '.ts',
      '.py',
      '.java',
      '.json',
      '.html',
      '.css',
      '.tsx',
      '.jsx',
      '.txt',
      '.md',
      '.yml',
      '.yaml',
      '.xml',
      '.sql',
    ].includes(extension)
  ) {
    return 'code';
  }
  return null;
}

function isLikelyImageGenerationPrompt(message: string): boolean {
  const lowered = message.trim().toLowerCase();
  if (!lowered) {
    return false;
  }
  if (lowered.startsWith('/image ')) {
    return true;
  }
  return /^(generate|create|draw|make|design)\b/.test(lowered);
}

function isSpreadsheetAttachment(attachment: ChatAttachment): boolean {
  const name = (attachment.file_name || '').toLowerCase();
  return name.endsWith('.csv') || name.endsWith('.xlsx');
}

function parseRetryAfterSeconds(message: string): number | null {
  const match = message.match(/retry-after:\s*(\d+)s/i);
  if (!match) {
    return null;
  }
  const seconds = Number.parseInt(match[1], 10);
  if (Number.isNaN(seconds) || seconds <= 0) {
    return null;
  }
  return seconds;
}

function isPermanentImageQuotaError(message: string): boolean {
  const lowered = message.toLowerCase();
  return (
    lowered.includes('quota is exhausted') ||
    lowered.includes('enable billing') ||
    lowered.includes('increase gemini image quota')
  );
}

function isBudgetExceededError(message: string): boolean {
  const lowered = message.toLowerCase();
  return (
    lowered.includes('budget has been exceeded') ||
    lowered.includes('max budget') ||
    lowered.includes('status 402')
  );
}

export default function ChatWindow() {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [chatTitle, setChatTitle] = useState('Chat History');
  const [chatItems, setChatItems] = useState<ChatThread[]>([]);
  const [activeChatId, setActiveChatId] = useState<number | null>(null);
  const [accessToken, setAccessToken] = useState<string>('');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingMode, setLoadingMode] = useState<'chat' | 'image' | 'database' | 'research' | 'support'>('chat');
  const [composerMode, setComposerMode] = useState<ChatMode>('chat');
  const [databaseUrl, setDatabaseUrl] = useState<string>(() => localStorage.getItem(databaseUrlStorageKey) || '');
  const [googleSheetUrl, setGoogleSheetUrl] = useState<string>(() => localStorage.getItem(googleSheetUrlStorageKey) || '');
  const [spreadsheetSheetName, setSpreadsheetSheetName] = useState('');
  const [checkingImageMode, setCheckingImageMode] = useState(false);
  const [imageModeHealthMessage, setImageModeHealthMessage] = useState<string | null>(null);
  const [imageRateLimitSeconds, setImageRateLimitSeconds] = useState(0);
  const [queuedImagePrompt, setQueuedImagePrompt] = useState<string | null>(null);
  const [researchProgress, setResearchProgress] = useState<string[]>([]);
  const [supportTickets, setSupportTickets] = useState<SupportTicket[]>([]);
  const [supportNotifications, setSupportNotifications] = useState<SupportNotificationEvent[]>([]);
  const [supportHealth, setSupportHealth] = useState<SupportWorkflowHealth | null>(null);
  const [supportHealthLoading, setSupportHealthLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [googleExpectedOrigin, setGoogleExpectedOrigin] = useState<string>('');
  const [editingChatId, setEditingChatId] = useState<number | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [chatSearch, setChatSearch] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [confirmingDeleteChatId, setConfirmingDeleteChatId] = useState<number | null>(null);
  const [deletingChatId, setDeletingChatId] = useState<number | null>(null);
  const [confirmingResetChatId, setConfirmingResetChatId] = useState<number | null>(null);
  const [clearingMemoryChatId, setClearingMemoryChatId] = useState<number | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [showFormulaEditor, setShowFormulaEditor] = useState(false);
  const [formulaInput, setFormulaInput] = useState('');
  const [showCodeEditor, setShowCodeEditor] = useState(false);
  const [codeSnippetTitle, setCodeSnippetTitle] = useState('snippet');
  const [codeSnippetLanguage, setCodeSnippetLanguage] = useState('typescript');
  const [codeSnippetInput, setCodeSnippetInput] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadingAttachmentCount = useMemo(
    () => pendingAttachments.filter((item) => item.status === 'uploading').length,
    [pendingAttachments],
  );
  const filteredChatItems = useMemo(() => {
    const searchTerm = chatSearch.trim().toLowerCase();
    if (!searchTerm) {
      return chatItems;
    }
    return chatItems.filter((item) => item.title.toLowerCase().includes(searchTerm));
  }, [chatItems, chatSearch]);
  const browserOrigin = window.location.origin;
  const hasOriginMismatch =
    !!googleExpectedOrigin &&
    normalizeLocalOriginForCompare(googleExpectedOrigin) !== normalizeLocalOriginForCompare(browserOrigin);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const authTokenFromQuery = params.get('auth_token');
    const authErrorFromQuery = params.get('auth_error');

    if (authErrorFromQuery) {
      setAuthError(authErrorFromQuery);
    }

    if (authTokenFromQuery) {
      localStorage.setItem(tokenStorageKey, authTokenFromQuery);
      void bootstrapSession(authTokenFromQuery);
      params.delete('auth_token');
      params.delete('auth_error');
      const nextQuery = params.toString();
      const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}`;
      window.history.replaceState({}, '', nextUrl);
      return;
    }

    const storedToken = localStorage.getItem(tokenStorageKey);
    if (!storedToken) {
      return;
    }

    void bootstrapSession(storedToken);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const config = await getGoogleAuthConfig();
        if (config.expected_origin) {
          setGoogleExpectedOrigin(config.expected_origin);
        }
        setGoogleEnabled(Boolean(config.enabled && config.client_id));
      } catch {
        // Keep email/password auth usable even if Google config fetch fails.
        setGoogleEnabled(false);
      }
    })();
  }, []);

  useEffect(() => {
    localStorage.setItem(databaseUrlStorageKey, databaseUrl);
  }, [databaseUrl]);

  useEffect(() => {
    localStorage.setItem(googleSheetUrlStorageKey, googleSheetUrl);
  }, [googleSheetUrl]);

  useEffect(() => {
    if (!accessToken) {
      setSupportTickets([]);
      setSupportNotifications([]);
      setSupportHealth(null);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    void (async () => {
      try {
        const initial = await listSupportTickets(accessToken, activeChatId ?? undefined);
        if (!cancelled) {
          setSupportTickets(initial.tickets);
        }
      } catch {
        // Keep support mode non-blocking if listing fails.
      }

      try {
        await streamSupportNotifications(
          accessToken,
          (event) => {
            if (cancelled || event.event_type === 'connected') {
              return;
            }

            setSupportNotifications((current) => [event, ...current].slice(0, 20));

            setMessages((current) => [
              ...current,
              {
                id: `support-notification-${Date.now()}`,
                role: 'assistant',
                text: `Support Update\nTicket ${event.ticket_id}\nStatus: ${event.status}\n${event.message}`,
              },
            ]);

            void (async () => {
              try {
                const refreshed = await listSupportTickets(accessToken, activeChatId ?? undefined);
                if (!cancelled) {
                  setSupportTickets(refreshed.tickets);
                }
              } catch {
                // Ignore refresh failures and continue stream consumption.
              }
            })();
          },
          controller.signal,
        );
      } catch {
        // Ignore stream errors to avoid disrupting chat mode.
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [accessToken, activeChatId]);

  useEffect(() => {
    if (!accessToken || composerMode !== 'support') {
      return;
    }
    void refreshSupportHealth();
  }, [accessToken, composerMode]);

  useEffect(() => {
    if (composerMode !== 'image' || !accessToken) {
      setCheckingImageMode(false);
      setImageModeHealthMessage(null);
      return;
    }

    let cancelled = false;
    setCheckingImageMode(true);

    void (async () => {
      try {
        const health = await getGeminiImageHealth(accessToken);
        if (cancelled) {
          return;
        }
        if (!health.ok) {
          setImageModeHealthMessage(health.message);
          setError(health.message);
          return;
        }
        setImageModeHealthMessage(null);
        setError((current) => {
          if (!current) {
            return current;
          }
          const lowered = current.toLowerCase();
          if (lowered.includes('gemini') || lowered.includes('image generation')) {
            return null;
          }
          return current;
        });
      } catch {
        if (cancelled) {
          return;
        }
        const message = 'Unable to verify image generation configuration right now.';
        setImageModeHealthMessage(message);
        setError(message);
      } finally {
        if (!cancelled) {
          setCheckingImageMode(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [composerMode, accessToken]);

  useEffect(() => {
    if (imageRateLimitSeconds <= 0) {
      return;
    }

    const timer = window.setInterval(() => {
      setImageRateLimitSeconds((current) => Math.max(0, current - 1));
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [imageRateLimitSeconds]);

  useEffect(() => {
    if (
      imageRateLimitSeconds !== 0 ||
      !queuedImagePrompt ||
      loading ||
      composerMode !== 'image' ||
      !accessToken ||
      !activeChatId ||
      checkingImageMode ||
      !!imageModeHealthMessage
    ) {
      return;
    }

    let cancelled = false;

    void (async () => {
      setError('Retrying queued image prompt...');
      setLoadingMode('image');
      setLoading(true);

      try {
        const response = await postChat(
          queuedImagePrompt,
          accessToken,
          activeChatId,
          [],
          'image',
        );

        if (cancelled) {
          return;
        }

        const assistantMessage: ChatMessage = {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          text: response.reply,
          attachments: response.attachments || [],
        };
        setMessages((current) => [...current, assistantMessage]);
        setQueuedImagePrompt(null);
        setImageRateLimitSeconds(0);
        setError(null);
      } catch (err) {
        if (cancelled) {
          return;
        }

        const message = err instanceof Error ? err.message : 'Unable to get a response from the backend.';
        if (/status 429/i.test(message)) {
          if (isPermanentImageQuotaError(message)) {
            setQueuedImagePrompt(null);
            setImageRateLimitSeconds(0);
            setError(
              'Image generation quota is exhausted for this project. Enable billing or increase Gemini image quota, then try again.'
            );
            return;
          }

          const retryAfterSeconds = parseRetryAfterSeconds(message) ?? 10;
          setImageRateLimitSeconds(retryAfterSeconds);
          setError(
            `Image generation is still rate-limited. Auto-retry in ${retryAfterSeconds}s.`
          );
          return;
        }

        setError(message);
      } finally {
        if (!cancelled) {
          setLoading(false);
          setLoadingMode('chat');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    imageRateLimitSeconds,
    queuedImagePrompt,
    loading,
    composerMode,
    accessToken,
    activeChatId,
    checkingImageMode,
    imageModeHealthMessage,
  ]);

  const handleGoogleSignIn = () => {
    window.location.href = `${apiBaseUrl}/api/auth/google/start`;
  };

  const bootstrapSession = async (token: string) => {
    setAuthLoading(true);
    setAuthError(null);

    try {
      const currentUser = await getCurrentUser(token);
      const threadResponse = await getThreads(token);
      let threads = threadResponse.threads;

      setAccessToken(token);
      setUser(currentUser);

      if (threads.length === 0) {
        const created = await createThread('New Chat', token);
        threads = [created];
      }

      setChatItems(threads);
      const firstThread = threads[0];
      setActiveChatId(firstThread.id);
      setChatTitle(firstThread.title);

      const history = await getThreadMessages(firstThread.id, token);
      if (history.messages.length === 0) {
        setMessages([
          {
            id: 'assistant-empty',
            role: 'assistant',
            text: 'No saved chats yet. Start by asking your first question.',
          },
        ]);
      } else {
        const restoredMessages = history.messages.map((message) => ({
          id: `msg-${message.id}`,
          role: message.role,
          text: message.content,
          attachments: message.attachments,
        }));
        setMessages(restoredMessages);
      }
    } catch {
      localStorage.removeItem(tokenStorageKey);
      setAccessToken('');
      setUser(null);
      setMessages(initialMessages);
      setChatItems([]);
      setActiveChatId(null);
      setAuthError('Session expired. Please sign in again.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthLoading(true);
    setAuthError(null);

    try {
      const response = await login(email, password);
      localStorage.setItem(tokenStorageKey, response.access_token);
      setPassword('');
      await bootstrapSession(response.access_token);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to sign in.';
      setAuthError(message);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSignup = async () => {
    if (!email.trim() || !password.trim()) {
      setAuthError('Enter email and password to sign up.');
      return;
    }

    setAuthLoading(true);
    setAuthError(null);

    try {
      const response = await signup(email, password);
      localStorage.setItem(tokenStorageKey, response.access_token);
      setPassword('');
      await bootstrapSession(response.access_token);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to sign up.';
      setAuthError(message);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem(tokenStorageKey);
    setAccessToken('');
    setUser(null);
    setInput('');
    setError(null);
    setAuthError(null);
    setChatTitle('Chat History');
    setChatItems([]);
    setActiveChatId(null);
    setConfirmingResetChatId(null);
    setPendingAttachments([]);
    setMessages(initialMessages);
  };

  const activateChat = async (chatId: number) => {
    if (!accessToken) {
      return;
    }

    const selectedChat = chatItems.find((item) => item.id === chatId);
    if (!selectedChat) {
      return;
    }

    setActiveChatId(chatId);
    setChatTitle(selectedChat.title);
    setError(null);
    setConfirmingResetChatId(null);
    setPendingAttachments([]);

    const history = await getThreadMessages(chatId, accessToken);
    if (history.messages.length === 0) {
      setMessages(newChatMessages);
      return;
    }

    setMessages(
      history.messages.map((message) => ({
        id: `msg-${message.id}`,
        role: message.role,
        text: message.content,
        attachments: message.attachments,
      })),
    );
  };

  const handleNewChat = async () => {
    if (!accessToken) {
      return;
    }

    const newTitle = createDefaultNewChatTitle(chatItems.length + 1);

    const created = await createThread(newTitle, accessToken);
    setChatItems((current) => [created, ...current]);
    setActiveChatId(created.id);
    setInput('');
    setError(null);
    setChatSearch('');
    setChatTitle(newTitle);
    setConfirmingResetChatId(null);
    setPendingAttachments([]);
    setMessages(newChatMessages);
  };

  const handleClearMemory = async () => {
    if (!accessToken) {
      return;
    }

    if (!activeChatId) {
      setError('Create or select a chat first.');
      return;
    }

    setClearingMemoryChatId(activeChatId);
    setError(null);

    try {
      await clearThreadMemory(activeChatId, accessToken);
      setMessages(newChatMessages);
      setConfirmingResetChatId(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to clear chat memory.';
      setError(message);
    } finally {
      setClearingMemoryChatId(null);
    }
  };

  const handleEditChat = (chatId: number) => {
    const target = chatItems.find((item) => item.id === chatId);
    if (!target) {
      return;
    }

    setEditingChatId(chatId);
    setEditingTitle(target.title);
  };

  const handleCancelEdit = () => {
    setEditingChatId(null);
    setEditingTitle('');
    setSavingEdit(false);
  };

  const handleSaveEdit = async (chatId: number) => {
    if (!accessToken) {
      return;
    }

    const nextTitle = editingTitle.trim();
    if (!nextTitle) {
      setError('Chat title cannot be empty.');
      return;
    }

    setSavingEdit(true);
    setError(null);

    try {
      const updated = await updateThread(chatId, nextTitle, accessToken);

      setChatItems((current) =>
        current.map((item) => (item.id === chatId ? updated : item)),
      );

      if (activeChatId === chatId) {
        setChatTitle(nextTitle);
      }

      handleCancelEdit();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to update chat title.';
      setError(message);
      setSavingEdit(false);
    }
  };

  const handleDeleteChat = async (chatId: number) => {
    if (!accessToken) {
      return;
    }

    const target = chatItems.find((item) => item.id === chatId);
    if (!target) {
      return;
    }

    setDeletingChatId(chatId);
    setError(null);

    try {
      await deleteThread(chatId, accessToken);

      if (editingChatId === chatId) {
        handleCancelEdit();
      }

      setConfirmingDeleteChatId((current) => (current === chatId ? null : current));

      const nextItems = chatItems.filter((item) => item.id !== chatId);
      setChatItems(nextItems);

      if (activeChatId !== chatId) {
        return;
      }

      if (nextItems.length === 0) {
        setActiveChatId(null);
        setChatTitle('New Chat');
        setMessages(newChatMessages);
        return;
      }

      const fallback = nextItems[0];
      setActiveChatId(fallback.id);
      setChatTitle(fallback.title);

      const history = await getThreadMessages(fallback.id, accessToken);
      if (history.messages.length === 0) {
        setMessages(newChatMessages);
        return;
      }

      setMessages(
        history.messages.map((message) => ({
          id: `msg-${message.id}`,
          role: message.role,
          text: message.content,
          attachments: message.attachments,
        })),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to delete chat.';
      setError(message);
    } finally {
      setDeletingChatId(null);
    }
  };

  const removePendingAttachment = (localId: string) => {
    setPendingAttachments((current) => {
      const next = current.filter((item) => item.localId !== localId);
      const removed = current.find((item) => item.localId === localId);
      if (removed?.previewUrl) {
        URL.revokeObjectURL(removed.previewUrl);
      }
      return next;
    });
  };

  const uploadFiles = async (files: FileList | File[]) => {
    if (!accessToken) {
      setError('Please sign in before uploading attachments.');
      return;
    }

    if (!activeChatId) {
      setError('Create or select a chat first.');
      return;
    }

    const fileList = Array.from(files);
    for (const file of fileList) {
      const extension = getFileExtension(file.name);
      const kind = inferAttachmentKind(extension);
      if (!kind) {
        setError(`Unsupported file type: ${file.name}`);
        continue;
      }

      if (file.size > maxAttachmentBytes) {
        setError(`${file.name} exceeds ${maxAttachmentSizeMb}MB.`);
        continue;
      }

      const localId = `${file.name}-${Date.now()}-${Math.random()}`;
      const previewUrl = kind === 'image' || kind === 'video' ? URL.createObjectURL(file) : undefined;

      setPendingAttachments((current) => [
        ...current,
        {
          localId,
          name: file.name,
          kind,
          status: 'uploading',
          progress: 0,
          previewUrl,
        },
      ]);

      try {
        const uploaded = await uploadAttachment(activeChatId, file, accessToken, (percent) => {
          setPendingAttachments((current) =>
            current.map((item) =>
              item.localId === localId
                ? {
                    ...item,
                    progress: percent,
                  }
                : item,
            ),
          );
        });

        setPendingAttachments((current) =>
          current.map((item) =>
            item.localId === localId
              ? {
                  ...item,
                  status: 'uploaded',
                  progress: 100,
                  attachment: uploaded,
                }
              : item,
          ),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Upload failed.';
        setPendingAttachments((current) =>
          current.map((item) =>
            item.localId === localId
              ? {
                  ...item,
                  status: 'error',
                  error: message,
                }
              : item,
          ),
        );
      }
    }
  };

  const handleFileInputChange = async (event: ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files || event.target.files.length === 0) {
      return;
    }
    await uploadFiles(event.target.files);
    event.target.value = '';
  };

  const handleDrop = async (event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDragActive(false);
    if (event.dataTransfer.files.length === 0) {
      return;
    }
    await uploadFiles(event.dataTransfer.files);
  };

  const handleFormulaAttach = async () => {
    if (!accessToken || !activeChatId) {
      setError('Create or select a chat first.');
      return;
    }

    const latex = formulaInput.trim();
    if (!latex) {
      setError('Formula cannot be empty.');
      return;
    }

    const localId = `formula-${Date.now()}`;
    setPendingAttachments((current) => [
      ...current,
      {
        localId,
        name: 'formula.tex',
        kind: 'formula',
        status: 'uploading',
        progress: 30,
      },
    ]);

    try {
      const uploaded = await uploadFormulaAttachment(activeChatId, latex, accessToken);
      setPendingAttachments((current) =>
        current.map((item) =>
          item.localId === localId
            ? {
                ...item,
                status: 'uploaded',
                progress: 100,
                attachment: uploaded,
              }
            : item,
        ),
      );
      setFormulaInput('');
      setShowFormulaEditor(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Formula upload failed.';
      setPendingAttachments((current) =>
        current.map((item) =>
          item.localId === localId
            ? {
                ...item,
                status: 'error',
                error: message,
              }
            : item,
        ),
      );
    }
  };

  const handleCodeSnippetAttach = async () => {
    if (!accessToken || !activeChatId) {
      setError('Create or select a chat first.');
      return;
    }

    const snippet = codeSnippetInput.trim();
    if (!snippet) {
      setError('Code snippet cannot be empty.');
      return;
    }

    const localId = `code-${Date.now()}`;
    setPendingAttachments((current) => [
      ...current,
      {
        localId,
        name: codeSnippetTitle || 'snippet',
        kind: 'code',
        status: 'uploading',
        progress: 30,
      },
    ]);

    try {
      const uploaded = await uploadCodeSnippetAttachment(
        activeChatId,
        snippet,
        accessToken,
        codeSnippetLanguage,
        codeSnippetTitle,
      );
      setPendingAttachments((current) =>
        current.map((item) =>
          item.localId === localId
            ? {
                ...item,
                status: 'uploaded',
                progress: 100,
                attachment: uploaded,
              }
            : item,
        ),
      );
      setCodeSnippetInput('');
      setShowCodeEditor(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Code snippet upload failed.';
      setPendingAttachments((current) =>
        current.map((item) =>
          item.localId === localId
            ? {
                ...item,
                status: 'error',
                error: message,
              }
            : item,
        ),
      );
    }
  };

  const { createTicket: handleCreateSupportTicket } = useSupportTicketCreation({
    accessToken,
    activeChatId,
    setError,
    setLoadingMode,
    setLoading,
    setSupportTickets,
    setMessages,
  });

  const refreshSupportHealth = async () => {
    if (!accessToken) {
      setSupportHealth(null);
      return;
    }

    setSupportHealthLoading(true);
    try {
      const health = await getSupportWorkflowHealth(accessToken);
      setSupportHealth(health);
    } catch {
      setSupportHealth({
        configured: false,
        active: false,
        fallback: true,
        reachable: false,
        http_status: null,
        webhook_url: '',
        message: 'Unable to verify n8n workflow readiness right now. Fallback mode may be used.',
      });
    } finally {
      setSupportHealthLoading(false);
    }
  };

  const handleSend = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessToken) {
      setError('Please sign in before sending messages.');
      return;
    }

    const trimmed = input.trim();
    const uploadedAttachments = pendingAttachments
      .filter((item) => item.status === 'uploaded' && item.attachment)
      .map((item) => item.attachment as ChatAttachment);

    if (composerMode === 'database' && !trimmed) {
      setError('Database mode requires a natural language question.');
      return;
    }

    if (composerMode === 'database' && !databaseUrl.trim()) {
      setError('Database mode requires a database connection URL.');
      return;
    }

    if (composerMode === 'spreadsheet' && !trimmed) {
      setError('Spreadsheet mode requires a natural language question.');
      return;
    }

    if (composerMode === 'spreadsheet') {
      const uploadedSpreadsheet = uploadedAttachments.some((item) => isSpreadsheetAttachment(item));
      const hasGoogleSheetSource = !!googleSheetUrl.trim();
      if (!uploadedSpreadsheet && !hasGoogleSheetSource) {
        setError('Spreadsheet mode requires a CSV/XLSX attachment or a Google Sheet URL.');
        return;
      }
    }

    if (composerMode === 'research' && !trimmed) {
      setError('Research mode requires a topic.');
      return;
    }

    if (composerMode === 'support') {
      setError('Use the Create Support Ticket section above to submit support requests.');
      return;
    }

    if (composerMode === 'image' && !trimmed) {
      setError('Image mode requires a prompt. Describe the image you want to generate.');
      return;
    }

    if (composerMode === 'image' && imageModeHealthMessage) {
      setError(imageModeHealthMessage);
      return;
    }

    if (composerMode === 'image' && imageRateLimitSeconds > 0) {
      if (trimmed) {
        setQueuedImagePrompt(trimmed);
      }
      setError(
        `Image generation is rate-limited. Prompt queued. Try again in ${imageRateLimitSeconds}s.`
      );
      return;
    }

    if (!trimmed && uploadedAttachments.length === 0) {
      return;
    }

    if (uploadingAttachmentCount > 0) {
      setError('Please wait for attachment uploads to finish.');
      return;
    }

    setError(null);
    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      text: trimmed || 'Sent attachments.',
      attachments: uploadedAttachments,
    };

    const currentChatId = activeChatId;
    if (!currentChatId) {
      setError('Create or select a chat first.');
      return;
    }

    setMessages((current) => [...current, userMessage]);
    setInput('');
    const requestText = trimmed || 'Please analyze the attached content.';
    const generatingImage = composerMode === 'image' || (uploadedAttachments.length === 0 && isLikelyImageGenerationPrompt(requestText));
    const queryingDatabase = composerMode === 'database';
    const queryingSpreadsheet = composerMode === 'spreadsheet';
    const queryingResearch = composerMode === 'research';
    const creatingSupportTicket = composerMode === 'support';
    setLoadingMode(
      queryingResearch
        ? 'research'
        : creatingSupportTicket
          ? 'support'
          : queryingSpreadsheet
            ? 'database'
            : queryingDatabase
              ? 'database'
              : generatingImage
                ? 'image'
                : 'chat',
    );
    setLoading(true);
    if (queryingResearch) {
      setResearchProgress([]);
    }

    try {
      if (composerMode === 'research') {
        const finalDigest = await streamResearchDigest(
          requestText,
          accessToken,
          currentChatId,
          (message) => {
            setResearchProgress((current) => {
              if (current[current.length - 1] === message) {
                return current;
              }
              return [...current, message];
            });
          },
        );

        const references = finalDigest.papers
          .slice(0, 6)
          .map((paper, index) => `${index + 1}. ${paper.title} (${paper.url})`)
          .join('\n');

        const assistantMessage: ChatMessage = {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          text: references
            ? `${finalDigest.digest}\n\n## References\n${references}`
            : finalDigest.digest,
          attachments: [],
        };
        setMessages((current) => [...current, assistantMessage]);
      } else {
        const response = await postChat(
          requestText,
          accessToken,
          currentChatId,
          uploadedAttachments.map((attachment) => attachment.id),
          composerMode,
          composerMode === 'database' ? databaseUrl.trim() : undefined,
          composerMode === 'spreadsheet' ? googleSheetUrl.trim() || undefined : undefined,
          composerMode === 'spreadsheet' ? spreadsheetSheetName.trim() || undefined : undefined,
        );
        const assistantMessage: ChatMessage = {
          id: `assistant-${Date.now()}`,
          role: 'assistant',
          text: response.reply,
          attachments: response.attachments || [],
        };
        setMessages((current) => [...current, assistantMessage]);
      }
      setQueuedImagePrompt(null);
      setImageRateLimitSeconds(0);
      setResearchProgress([]);
      pendingAttachments.forEach((item) => {
        if (item.previewUrl) {
          URL.revokeObjectURL(item.previewUrl);
        }
      });
      setPendingAttachments([]);

      // Auto-rename chat to first message if it's a default-named chat
      if (chatTitle.startsWith('New Chat ')) {
        try {
          const newTitle = trimmed.substring(0, 100); // Limit to 100 chars
          const updated = await updateThread(currentChatId, newTitle, accessToken);
          setChatTitle(newTitle);
          setChatItems((current) =>
            current.map((item) =>
              item.id === currentChatId ? updated : item,
            ),
          );
        } catch {
          // Silently fail; chat title update is not critical
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to get a response from the backend.';

      if (isBudgetExceededError(message)) {
        setError(
          'The AI service budget has been exceeded. Please contact your administrator to increase the LiteLLM proxy budget limit.'
        );
        return;
      }

      if (composerMode === 'image' && /status 429/i.test(message)) {
        if (isPermanentImageQuotaError(message)) {
          setQueuedImagePrompt(null);
          setImageRateLimitSeconds(0);
          setError(
            'Image generation quota is exhausted for this project. Enable billing or increase Gemini image quota, then try again.'
          );
          return;
        }

        const retryAfterSeconds = parseRetryAfterSeconds(message) ?? 10;
        setImageRateLimitSeconds(retryAfterSeconds);
        if (trimmed) {
          setQueuedImagePrompt(trimmed);
        }
        setError(
          `Image generation is temporarily rate-limited. We queued your prompt and will auto-retry in ${retryAfterSeconds}s.`
        );
        return;
      }
      setError(message);
    } finally {
      setLoading(false);
      setLoadingMode('chat');
    }
  };

  if (!user) {
    return (
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-xl items-center px-4 py-8 sm:px-6">
        <div className="w-full rounded-3xl border border-slate-800 bg-slate-950/90 p-6 shadow-xl shadow-slate-950/20">
          <p className="text-sm uppercase tracking-[0.24em] text-sky-400/80">Amzur AI Chat</p>
          <h1 className="mt-2 text-3xl font-semibold text-white">Employee Login</h1>
          <p className="mt-2 text-sm text-slate-300">
            Use your @amzur.com email to sign up or sign in and load stored chat history.
          </p>

          <form onSubmit={handleLogin} className="mt-6 space-y-4">
            <div>
              <label htmlFor="email" className="mb-2 block text-sm text-slate-200">
                Work Email
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="w-full rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/20"
                placeholder="you@amzur.com"
              />
            </div>

            <div>
              <label htmlFor="password" className="mb-2 block text-sm text-slate-200">
                Password
              </label>
              <input
                id="password"
                type="password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="w-full rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/20"
                placeholder="Enter your password"
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <button
                type="submit"
                disabled={authLoading}
                className="inline-flex h-12 w-full items-center justify-center rounded-2xl bg-sky-500 px-6 text-sm font-semibold text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-600"
              >
                {authLoading ? 'Working…' : 'Sign in'}
              </button>

              <button
                type="button"
                onClick={handleSignup}
                disabled={authLoading}
                className="inline-flex h-12 w-full items-center justify-center rounded-2xl border border-slate-600 bg-slate-900 px-6 text-sm font-semibold text-slate-100 transition hover:border-slate-400 hover:bg-slate-800 disabled:cursor-not-allowed disabled:border-slate-700 disabled:text-slate-400"
              >
                {authLoading ? 'Working…' : 'Sign up'}
              </button>
            </div>

            <div className="pt-2">
              <p className="mb-2 text-xs uppercase tracking-[0.16em] text-slate-400">Or continue with Google</p>
              <button
                type="button"
                onClick={handleGoogleSignIn}
                disabled={authLoading || !googleEnabled}
                className="inline-flex h-12 w-full items-center justify-center rounded-2xl border border-slate-600 bg-slate-900 px-6 text-sm font-semibold text-slate-100 transition hover:border-slate-400 hover:bg-slate-800 disabled:cursor-not-allowed disabled:border-slate-700 disabled:text-slate-400"
              >
                {authLoading ? 'Working…' : 'Continue with Google'}
              </button>

              {!googleEnabled ? (
                <p className="mt-2 text-xs text-amber-300">
                  Google sign-in is disabled. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in backend/.env.
                </p>
              ) : null}

              {hasOriginMismatch ? (
                <div className="mb-2 rounded-xl border border-amber-700/70 bg-amber-950/30 px-3 py-2 text-[11px] leading-5 text-amber-200">
                  <p>Browser origin: {browserOrigin}</p>
                  <p>Expected origin: {googleExpectedOrigin}</p>
                </div>
              ) : null}
              {hasOriginMismatch ? (
                <p className="mb-2 text-xs text-amber-300">
                  Origin mismatch detected. Add both origins to Google OAuth Authorized JavaScript origins.
                </p>
              ) : null}
            </div>
          </form>

          {authError ? <p className="mt-4 text-sm text-rose-400">{authError}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-4xl flex-col gap-6 px-4 py-8 sm:px-6">
      <div className="rounded-3xl border border-slate-700 bg-slate-950/90 p-6 shadow-xl shadow-slate-950/20">
        <div className="mb-4 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm uppercase tracking-[0.24em] text-sky-400/80">Amzur AI Chat</p>
            <h1 className="text-3xl font-semibold text-white">Employee Assistant</h1>
            <p className="mt-1 text-xs text-slate-400">Signed in as {user.email}</p>
          </div>

          <div className="flex items-center gap-3">
            <span className="rounded-full bg-slate-800 px-3 py-1 text-xs uppercase tracking-[0.18em] text-slate-300">
              Local API
            </span>
            <button
              type="button"
              onClick={handleLogout}
              className="rounded-full border border-slate-700 px-3 py-1 text-xs uppercase tracking-[0.18em] text-slate-200 transition hover:border-slate-500 hover:text-white"
            >
              Logout
            </button>
          </div>
        </div>

        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-300">{chatTitle}</h2>
            <p className="mt-1 text-[11px] uppercase tracking-[0.16em] text-slate-500">
              Session memory keeps the latest 5 conversations.
            </p>
          </div>

          {activeChatId ? (
            confirmingResetChatId === activeChatId ? (
              <div className="flex items-center gap-2 rounded-full border border-amber-700/70 bg-amber-950/30 px-2 py-1">
                <span className="px-2 text-[11px] uppercase tracking-[0.16em] text-amber-200">
                  Clear this chat memory?
                </span>
                <button
                  type="button"
                  onClick={() => {
                    void handleClearMemory();
                  }}
                  disabled={clearingMemoryChatId === activeChatId}
                  className="rounded-full border border-amber-500/70 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-100 transition hover:border-amber-300 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {clearingMemoryChatId === activeChatId ? 'Clearing...' : 'Confirm'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmingResetChatId(null);
                  }}
                  disabled={clearingMemoryChatId === activeChatId}
                  className="rounded-full border border-slate-600 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-300 transition hover:border-slate-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setConfirmingResetChatId(activeChatId);
                }}
                className="rounded-full border border-amber-700/70 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-amber-200 transition hover:border-amber-500 hover:text-amber-100"
              >
                Clear Memory
              </button>
            )
          ) : null}
        </div>

        {composerMode === 'support' ? (
          <SupportTicketSection
            loading={loading && loadingMode === 'support'}
            canCreateTicket={!!activeChatId}
            supportHealth={supportHealth}
            supportHealthLoading={supportHealthLoading}
            supportTickets={supportTickets}
            supportNotifications={supportNotifications}
            onCreateTicket={handleCreateSupportTicket}
            onRefreshHealth={refreshSupportHealth}
          />
        ) : null}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
          <aside className="rounded-2xl border border-slate-800 bg-slate-900/70 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Chats</p>
              <button
                type="button"
                onClick={handleNewChat}
                className="rounded-full border border-sky-600/70 bg-sky-900/20 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-sky-100 transition hover:border-sky-400 hover:text-white"
              >
                + New Chat
              </button>
            </div>

            <input
              value={chatSearch}
              onChange={(event) => setChatSearch(event.target.value)}
              placeholder="Search chats"
              className="mb-2 h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/20"
              aria-label="Search chats"
            />

            <p className="mb-2 text-[11px] uppercase tracking-[0.14em] text-slate-500">
              Tip: Rename and delete actions are on each chat card.
            </p>

            <div className="space-y-2">
              {filteredChatItems.length === 0 ? (
                <div className="rounded-xl border border-slate-800 bg-slate-900 px-3 py-4 text-xs text-slate-400">
                  No chats match your search.
                </div>
              ) : null}

              {filteredChatItems.map((chat) => (
                <div
                  key={chat.id}
                  className={`rounded-xl border px-3 py-2 ${
                    chat.id === activeChatId
                      ? 'border-sky-400/60 bg-slate-800'
                      : 'border-slate-800 bg-slate-900'
                  }`}
                >
                  {editingChatId === chat.id ? (
                    <div className="mt-1 flex items-center gap-2">
                      <input
                        value={editingTitle}
                        onChange={(event) => setEditingTitle(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            void handleSaveEdit(chat.id);
                          }
                          if (event.key === 'Escape') {
                            event.preventDefault();
                            handleCancelEdit();
                          }
                        }}
                        className="h-8 w-full rounded-md border border-slate-600 bg-slate-950 px-2 text-sm text-slate-100 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/20"
                        aria-label="Edit chat title"
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={() => {
                          void handleSaveEdit(chat.id);
                        }}
                        disabled={savingEdit}
                        aria-label="Save title"
                        title="Save title"
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-emerald-700/70 text-emerald-300 transition hover:border-emerald-500 hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          className="h-4 w-4"
                          aria-hidden="true"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="m5 13 4 4L19 7" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={handleCancelEdit}
                        disabled={savingEdit}
                        aria-label="Cancel edit"
                        title="Cancel edit"
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-600 text-slate-300 transition hover:border-slate-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          className="h-4 w-4"
                          aria-hidden="true"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="m18 6-12 12M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          void activateChat(chat.id);
                        }}
                        className="w-full truncate text-left text-sm text-slate-100"
                      >
                        {chat.title}
                      </button>

                      {confirmingDeleteChatId === chat.id ? (
                        <div className="mt-2 rounded-lg border border-rose-800/70 bg-rose-950/30 p-2">
                          <p className="text-xs text-rose-200">Delete this chat?</p>
                          <div className="mt-2 flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                void handleDeleteChat(chat.id);
                              }}
                              disabled={deletingChatId === chat.id}
                              className="inline-flex h-8 items-center justify-center rounded-md border border-rose-700/70 px-3 text-xs font-medium text-rose-200 transition hover:border-rose-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              {deletingChatId === chat.id ? 'Deleting...' : 'Confirm'}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setConfirmingDeleteChatId((current) => (current === chat.id ? null : current));
                              }}
                              disabled={deletingChatId === chat.id}
                              className="inline-flex h-8 items-center justify-center rounded-md border border-slate-600 px-3 text-xs font-medium text-slate-300 transition hover:border-slate-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="mt-2 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              handleEditChat(chat.id);
                            }}
                            className="inline-flex h-8 items-center justify-center rounded-md border border-slate-700 px-3 text-xs font-medium uppercase tracking-[0.14em] text-slate-300 transition hover:border-slate-500 hover:text-white"
                          >
                            Rename
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setConfirmingDeleteChatId(chat.id);
                            }}
                            className="inline-flex h-8 items-center justify-center rounded-md border border-rose-700/70 px-3 text-xs font-medium uppercase tracking-[0.14em] text-rose-300 transition hover:border-rose-500 hover:text-rose-200"
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          </aside>

          <div className="space-y-4 rounded-3xl border border-slate-800 bg-slate-900/90 p-4">
          {messages.map((message) => (
            <div
              key={message.id}
              className={`rounded-2xl p-4 shadow-sm ${
                message.role === 'user'
                  ? 'bg-slate-800 text-slate-100 self-end'
                  : 'bg-slate-900 text-slate-200'
              }`}
            >
              <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-slate-500">
                <span>{message.role === 'user' ? 'You' : 'Assistant'}</span>
                {message.role === 'assistant' ? (
                  <span className="rounded-full border border-sky-700/60 bg-sky-900/30 px-2 py-0.5 text-[10px] tracking-[0.14em] text-sky-200">
                    Using last 5 conversations
                  </span>
                ) : null}
              </div>
              {message.role === 'assistant' ? (
                <AssistantMessageContent text={message.text} />
              ) : (
                <p className="whitespace-pre-wrap text-sm leading-7">{message.text}</p>
              )}
              {message.attachments && message.attachments.length > 0 ? (
                <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {message.attachments.map((attachment) => (
                    <AttachmentPreview
                      key={`msg-attachment-${message.id}-${attachment.id}`}
                      attachment={attachment}
                      accessToken={accessToken}
                      compact={message.role !== 'user'}
                    />
                  ))}
                </div>
              ) : null}
              {message.role === 'assistant' && message.attachments && message.attachments.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {message.attachments
                    .filter((attachment) => attachment.kind === 'image' && attachment.language === 'prompt' && attachment.text_content)
                    .map((attachment) => (
                      <button
                        key={`regen-${message.id}-${attachment.id}`}
                        type="button"
                        onClick={() => {
                          setInput(attachment.text_content || '');
                          const target = document.getElementById('chat-input');
                          if (target instanceof HTMLTextAreaElement) {
                            target.focus();
                          }
                        }}
                        className="rounded-full border border-sky-700/70 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-sky-200 transition hover:border-sky-500 hover:text-sky-100"
                      >
                        Regenerate with edits
                      </button>
                    ))}
                </div>
              ) : null}
            </div>
          ))}
          </div>
        </div>

        <form
          onSubmit={handleSend}
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            setDragActive(false);
          }}
          onDrop={(event) => {
            void handleDrop(event);
          }}
          className={`mt-6 rounded-3xl border p-4 transition ${
            dragActive
              ? 'border-sky-500 bg-sky-950/20'
              : 'border-slate-800 bg-slate-950/50'
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            accept={supportedFileExtensions.join(',')}
            onChange={(event) => {
              void handleFileInputChange(event);
            }}
          />

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900/70 p-1">
              <button
                type="button"
                onClick={() => setComposerMode('chat')}
                className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] transition ${
                  composerMode === 'chat'
                    ? 'bg-slate-700 text-white'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                Chat
              </button>
              <button
                type="button"
                onClick={() => setComposerMode('image')}
                className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] transition ${
                  composerMode === 'image'
                    ? 'bg-sky-600 text-white'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                Image
              </button>
              <button
                type="button"
                onClick={() => setComposerMode('database')}
                className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] transition ${
                  composerMode === 'database'
                    ? 'bg-emerald-600 text-white'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                Database
              </button>
              <button
                type="button"
                onClick={() => setComposerMode('spreadsheet')}
                className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] transition ${
                  composerMode === 'spreadsheet'
                    ? 'bg-emerald-600 text-white'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                Spreadsheet
              </button>
              <button
                type="button"
                onClick={() => setComposerMode('research')}
                className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] transition ${
                  composerMode === 'research'
                    ? 'bg-amber-600 text-white'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                Research
              </button>
              <button
                type="button"
                onClick={() => setComposerMode('support')}
                className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] transition ${
                  composerMode === 'support'
                    ? 'bg-gradient-to-r from-cyan-500 to-blue-500 text-white shadow-[0_8px_20px_rgba(14,165,233,0.35)]'
                    : 'border border-cyan-500/50 bg-cyan-500/10 text-cyan-200 hover:border-cyan-300 hover:text-white'
                }`}
              >
                n8n Support Ticket
              </button>
            </div>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="rounded-full border border-slate-700 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-slate-200 transition hover:border-slate-500 hover:text-white"
            >
              Attach Files
            </button>
            <button
              type="button"
              onClick={() => setShowFormulaEditor((current) => !current)}
              className="rounded-full border border-emerald-700/70 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-emerald-200 transition hover:border-emerald-500 hover:text-emerald-100"
            >
              Add Formula
            </button>
            <button
              type="button"
              onClick={() => setShowCodeEditor((current) => !current)}
              className="rounded-full border border-sky-700/70 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-sky-200 transition hover:border-sky-500 hover:text-sky-100"
            >
              Add Snippet
            </button>
            <span className="text-[11px] text-slate-400">
              Drag and drop files here. Max {maxAttachmentSizeMb}MB each.
            </span>
          </div>

          {composerMode === 'image' ? (
            <div className="mb-3 rounded-2xl border border-sky-800/70 bg-sky-950/20 px-3 py-2 text-xs text-sky-100">
              <div className="flex flex-wrap items-center gap-2">
                <span>
                  {checkingImageMode
                    ? 'Checking image generation configuration...'
                    : imageModeHealthMessage
                      ? imageModeHealthMessage
                      : imageRateLimitSeconds > 0
                        ? `Rate limited. Retry in ${imageRateLimitSeconds}s.`
                        : queuedImagePrompt
                          ? 'Prompt queued. Click Send to retry now.'
                          : 'Image mode ready. Enter a prompt to generate an image.'}
                </span>
                {imageRateLimitSeconds > 0 || queuedImagePrompt ? (
                  <button
                    type="button"
                    onClick={() => {
                      setImageRateLimitSeconds(0);
                      if (queuedImagePrompt) {
                        setInput(queuedImagePrompt);
                      }
                      const target = document.getElementById('chat-input');
                      if (target instanceof HTMLTextAreaElement) {
                        target.focus();
                      }
                    }}
                    className="rounded-full border border-sky-600/70 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-sky-100 transition hover:border-sky-400 hover:text-white"
                  >
                    Retry now
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {composerMode === 'database' ? (
            <div className="mb-3 rounded-2xl border border-emerald-800/70 bg-emerald-950/20 px-3 py-2 text-xs text-emerald-100">
              <p className="mb-2">
                Database mode converts your natural language prompt into a read-only SQL query and executes it.
              </p>
              <label htmlFor="database-url" className="mb-1 block text-[11px] uppercase tracking-[0.14em] text-emerald-300">
                Database Connection URL
              </label>
              <input
                id="database-url"
                value={databaseUrl}
                onChange={(event) => setDatabaseUrl(event.target.value)}
                className="w-full rounded-xl border border-emerald-800/70 bg-slate-950 px-3 py-2 text-xs text-slate-100 outline-none transition focus:border-emerald-500"
                placeholder="sqlite:///C:/path/to/app.db or postgresql+psycopg2://user:password@host:5432/db"
              />
            </div>
          ) : null}

          {composerMode === 'spreadsheet' ? (
            <div className="mb-3 rounded-2xl border border-emerald-800/70 bg-emerald-950/20 px-3 py-2 text-xs text-emerald-100">
              <p className="mb-2">
                Upload CSV/XLSX using Attach Files or provide a Google Sheet URL. Then ask analysis questions in plain English.
              </p>
              <label htmlFor="google-sheet-url" className="mb-1 block text-[11px] uppercase tracking-[0.14em] text-emerald-300">
                Google Sheet URL (Optional if file is attached)
              </label>
              <input
                id="google-sheet-url"
                value={googleSheetUrl}
                onChange={(event) => setGoogleSheetUrl(event.target.value)}
                className="mb-2 w-full rounded-xl border border-emerald-800/70 bg-slate-950 px-3 py-2 text-xs text-slate-100 outline-none transition focus:border-emerald-500"
                placeholder="https://docs.google.com/spreadsheets/d/..."
              />

              <label htmlFor="sheet-name" className="mb-1 block text-[11px] uppercase tracking-[0.14em] text-emerald-300">
                Sheet Name (Optional)
              </label>
              <input
                id="sheet-name"
                value={spreadsheetSheetName}
                onChange={(event) => setSpreadsheetSheetName(event.target.value)}
                className="w-full rounded-xl border border-emerald-800/70 bg-slate-950 px-3 py-2 text-xs text-slate-100 outline-none transition focus:border-emerald-500"
                placeholder="e.g. Sales_Q1"
              />
            </div>
          ) : null}

          {composerMode === 'research' ? (
            <div className="mb-3 rounded-2xl border border-amber-800/70 bg-amber-950/20 px-3 py-2 text-xs text-amber-100">
              <p>
                Research mode runs an autonomous LangGraph workflow over arXiv: query generation, iterative evidence gathering,
                ranking, sufficiency checks, and structured digest generation.
              </p>
              {loading && loadingMode === 'research' && researchProgress.length > 0 ? (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] text-amber-200">
                  {researchProgress.slice(-6).map((item, index) => (
                    <li key={`research-progress-${index}`}>{item}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {composerMode === 'support' ? (
            <div className="mb-3 rounded-2xl border border-rose-800/70 bg-rose-950/20 px-3 py-2 text-xs text-rose-100">
              <p>
                Support mode is active. Use the n8n Support Ticket Desk section above to create and track tickets.
              </p>
            </div>
          ) : null}

          {showFormulaEditor ? (
            <div className="mb-3 rounded-2xl border border-emerald-800/70 bg-emerald-950/20 p-3">
              <p className="text-xs uppercase tracking-[0.14em] text-emerald-300">LaTeX Formula</p>
              <textarea
                value={formulaInput}
                onChange={(event) => setFormulaInput(event.target.value)}
                rows={3}
                className="mt-2 w-full resize-none rounded-xl border border-emerald-800/70 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-emerald-500"
                placeholder="e.g. \\int_0^1 x^2 dx"
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    void handleFormulaAttach();
                  }}
                  className="rounded-full border border-emerald-600/70 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-emerald-200 transition hover:border-emerald-400 hover:text-emerald-100"
                >
                  Attach Formula
                </button>
                <button
                  type="button"
                  onClick={() => setShowFormulaEditor(false)}
                  className="rounded-full border border-slate-700 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-slate-300 transition hover:border-slate-500 hover:text-white"
                >
                  Close
                </button>
              </div>
            </div>
          ) : null}

          {showCodeEditor ? (
            <div className="mb-3 rounded-2xl border border-sky-800/70 bg-sky-950/20 p-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input
                  value={codeSnippetTitle}
                  onChange={(event) => setCodeSnippetTitle(event.target.value)}
                  className="rounded-xl border border-sky-800/70 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-sky-500"
                  placeholder="Snippet title"
                />
                <input
                  value={codeSnippetLanguage}
                  onChange={(event) => setCodeSnippetLanguage(event.target.value)}
                  className="rounded-xl border border-sky-800/70 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-sky-500"
                  placeholder="Language (ts, py, java...)"
                />
              </div>
              <textarea
                value={codeSnippetInput}
                onChange={(event) => setCodeSnippetInput(event.target.value)}
                rows={5}
                className="mt-2 w-full resize-none rounded-xl border border-sky-800/70 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100 outline-none transition focus:border-sky-500"
                placeholder="Paste code snippet..."
              />
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    void handleCodeSnippetAttach();
                  }}
                  className="rounded-full border border-sky-600/70 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-sky-200 transition hover:border-sky-400 hover:text-sky-100"
                >
                  Attach Snippet
                </button>
                <button
                  type="button"
                  onClick={() => setShowCodeEditor(false)}
                  className="rounded-full border border-slate-700 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-slate-300 transition hover:border-slate-500 hover:text-white"
                >
                  Close
                </button>
              </div>
            </div>
          ) : null}

          {pendingAttachments.length > 0 ? (
            <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {pendingAttachments.map((item) => (
                <div key={item.localId} className="rounded-xl border border-slate-700/70 bg-slate-900/80 p-2">
                  {item.attachment ? (
                    <AttachmentPreview
                      attachment={item.attachment}
                      previewUrl={item.previewUrl}
                    />
                  ) : (
                    <div className="rounded-lg border border-slate-700/70 bg-slate-950/70 p-2">
                      <p className="truncate text-xs text-slate-200">{item.name}</p>
                      <p className="mt-1 text-[11px] uppercase tracking-[0.14em] text-slate-500">{item.kind}</p>
                    </div>
                  )}
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="text-[11px] text-slate-400">
                      {item.status === 'uploading'
                        ? `Uploading ${item.progress}%`
                        : item.status === 'uploaded'
                          ? 'Ready'
                          : item.error || 'Upload failed'}
                    </span>
                    <button
                      type="button"
                      onClick={() => removePendingAttachment(item.localId)}
                      className="rounded-full border border-slate-700 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-300 transition hover:border-slate-500 hover:text-white"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {composerMode === 'support' ? (
            <div className="rounded-2xl border border-rose-900/70 bg-slate-950/40 px-4 py-3 text-xs text-rose-200">
              Support ticket creation is handled in the n8n Support Ticket Desk section above.
            </div>
          ) : (
            <div className="flex flex-col gap-4 sm:flex-row">
              <label htmlFor="chat-input" className="sr-only">
                Chat message
              </label>
              <textarea
                id="chat-input"
                aria-label="Type your message"
                rows={3}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                className="min-h-[96px] flex-1 resize-none rounded-3xl border border-slate-800 bg-slate-950 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-400/20"
                placeholder={
                  composerMode === 'image'
                    ? 'Describe the image you want to generate...'
                    : composerMode === 'database'
                      ? 'Ask a database question, e.g. Top 5 customers by revenue this month'
                      : composerMode === 'research'
                        ? 'Enter a research topic, e.g. Multimodal Retrieval-Augmented Generation'
                        : 'Type a question, or send only attachments...'
                }
              />
              <button
                type="submit"
                disabled={
                  loading ||
                  authLoading ||
                  uploadingAttachmentCount > 0 ||
                  (composerMode === 'image' && checkingImageMode)
                }
                className="inline-flex h-14 items-center justify-center rounded-3xl bg-sky-500 px-6 text-sm font-semibold text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-600"
              >
                {loading
                  ? loadingMode === 'image'
                    ? 'Generating image…'
                    : loadingMode === 'database'
                      ? composerMode === 'spreadsheet'
                        ? 'Analyzing sheet…'
                        : 'Querying DB…'
                      : loadingMode === 'research'
                        ? 'Researching…'
                    : 'Thinking…'
                  : uploadingAttachmentCount > 0
                    ? 'Uploading…'
                    : 'Send'}
              </button>
            </div>
          )}
        </form>

        {error ? <p className="text-sm text-rose-400">{error}</p> : null}
      </div>
    </div>
  );
}
