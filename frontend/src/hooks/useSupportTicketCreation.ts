import type { Dispatch, SetStateAction } from 'react';

import { createSupportTicket } from '../lib/api';
import { ChatMessage, SupportTicket } from '../types';

type UseSupportTicketCreationArgs = {
  accessToken: string;
  activeChatId: number | null;
  setError: (value: string | null) => void;
  setLoadingMode: (value: 'chat' | 'image' | 'database' | 'research' | 'support') => void;
  setLoading: (value: boolean) => void;
  setSupportTickets: Dispatch<SetStateAction<SupportTicket[]>>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
};

export function useSupportTicketCreation({
  accessToken,
  activeChatId,
  setError,
  setLoadingMode,
  setLoading,
  setSupportTickets,
  setMessages,
}: UseSupportTicketCreationArgs) {
  const toTitleCase = (value: string): string =>
    value
      .split(/[_\s]+/)
      .filter(Boolean)
      .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase())
      .join(' ');

  const createTicket = async (issueSummaryInput: string, issueDescriptionInput: string) => {
    if (!accessToken) {
      setError('Please sign in before creating support tickets.');
      return;
    }

    if (!activeChatId) {
      setError('Create or select a chat first.');
      return;
    }

    const issueSummary = issueSummaryInput.trim();
    const issueDescription = issueDescriptionInput.trim();

    if (issueSummary.length < 5) {
      setError('Support issue summary must be at least 5 characters.');
      return;
    }

    if (issueDescription.length < 10) {
      setError('Support issue description must be at least 10 characters.');
      return;
    }

    setError(null);
    setLoadingMode('support');
    setLoading(true);

    try {
      const ticket = await createSupportTicket(
        issueSummary.slice(0, 300),
        issueDescription,
        accessToken,
        activeChatId,
      );

      setSupportTickets((current) => [ticket, ...current.filter((item) => item.ticket_id !== ticket.ticket_id)]);

      const assistantMessage: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        text:
          `🔎 Analyzing your issue...\n\n` +
          `🗂️ Creating support ticket...\n\n` +
          `📨 Routing to support team...\n\n` +
          `✅ IT Support Ticket Created Successfully\n\n` +
          `Ticket ID: ${ticket.ticket_id}  ` +
          `Category: ${toTitleCase(ticket.category || 'General')} ` +
          `Subcategory: None ` +
          `Priority: ${toTitleCase(ticket.priority || 'High')} ` +
          `Assigned Team: Unassigned\n` +
          `Status: ${toTitleCase(ticket.status === 'open' ? 'received' : ticket.status)}\n\n` +
          `${ticket.message || 'Our support team has been notified.'}`, 
        attachments: [],
      };
      setMessages((current) => [...current, assistantMessage]);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to create support ticket.';
      setError(message);
    } finally {
      setLoading(false);
      setLoadingMode('chat');
    }
  };

  return { createTicket };
}
