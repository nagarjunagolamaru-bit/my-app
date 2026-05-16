import { FormEvent, useEffect, useState } from 'react';
import {
  apiBaseUrl,
  createThread,
  deleteThread,
  getGoogleAuthConfig,
  getCurrentUser,
  getThreadMessages,
  getThreads,
  login,
  postChat,
  signup,
  tokenStorageKey,
  updateThread,
} from '../../lib/api';
import { AuthUser, ChatMessage, ChatThread } from '../../types';

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
  const [error, setError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [googleExpectedOrigin, setGoogleExpectedOrigin] = useState<string>('');
  const [editingChatId, setEditingChatId] = useState<number | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const browserOrigin = window.location.origin;
  const hasOriginMismatch = !!googleExpectedOrigin && googleExpectedOrigin !== browserOrigin;

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
    setChatTitle(newTitle);
    setMessages(newChatMessages);
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

    const shouldDelete = window.confirm(`Delete "${target.title}"?`);
    if (!shouldDelete) {
      return;
    }

    await deleteThread(chatId, accessToken);

    if (editingChatId === chatId) {
      handleCancelEdit();
    }

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
      })),
    );
  };

  const handleSend = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!accessToken) {
      setError('Please sign in before sending messages.');
      return;
    }

    const trimmed = input.trim();
    if (!trimmed) {
      return;
    }

    setError(null);
    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      text: trimmed,
    };

    const currentChatId = activeChatId;
    if (!currentChatId) {
      setError('Create or select a chat first.');
      return;
    }

    setMessages((current) => [...current, userMessage]);
    setInput('');
    setLoading(true);

    try {
      const response = await postChat(trimmed, accessToken, currentChatId);
      const assistantMessage: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        text: response.reply,
      };
      setMessages((current) => [...current, assistantMessage]);

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
      setError(message);
    } finally {
      setLoading(false);
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

        <div className="mb-3 flex items-center justify-start">
          <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-slate-300">{chatTitle}</h2>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
          <aside className="rounded-2xl border border-slate-800 bg-slate-900/70 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">Chats</p>
              <button
                type="button"
                onClick={handleNewChat}
                className="rounded-full border border-slate-700 px-3 py-1 text-xs uppercase tracking-[0.18em] text-slate-200 transition hover:border-slate-500 hover:text-white"
              >
                New Chat
              </button>
            </div>

            <div className="space-y-2">
              {chatItems.map((chat) => (
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

                      <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        handleEditChat(chat.id);
                      }}
                      aria-label="Edit chat"
                      title="Edit chat"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-700 text-slate-300 transition hover:border-slate-500 hover:text-white"
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
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 3.487a2.1 2.1 0 1 1 2.97 2.97L8.4 17.889 4 19l1.111-4.4L16.862 3.487Z" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void handleDeleteChat(chat.id);
                      }}
                      aria-label="Delete chat"
                      title="Delete chat"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-rose-700/70 text-rose-300 transition hover:border-rose-500 hover:text-rose-200"
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
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 6h18" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8 6V4h8v2" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 6l-1 14H6L5 6" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M10 11v6M14 11v6" />
                      </svg>
                    </button>
                      </div>
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
              </div>
              <p className="whitespace-pre-wrap text-sm leading-7">{message.text}</p>
            </div>
          ))}
          </div>
        </div>

        <form onSubmit={handleSend} className="mt-6 flex flex-col gap-4 sm:flex-row">
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
            placeholder="Type a question for the assistant..."
          />
          <button
            type="submit"
            disabled={loading || authLoading}
            className="inline-flex h-14 items-center justify-center rounded-3xl bg-sky-500 px-6 text-sm font-semibold text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-600"
          >
            {loading ? 'Thinking…' : 'Send'}
          </button>
        </form>

        {error ? <p className="text-sm text-rose-400">{error}</p> : null}
      </div>
    </div>
  );
}
