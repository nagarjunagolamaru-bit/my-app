import { useState } from 'react';

import { SupportNotificationEvent, SupportTicket, SupportWorkflowHealth } from '../../types';

type SupportTicketSectionProps = {
  loading: boolean;
  canCreateTicket: boolean;
  supportHealth: SupportWorkflowHealth | null;
  supportHealthLoading: boolean;
  supportTickets: SupportTicket[];
  supportNotifications: SupportNotificationEvent[];
  onCreateTicket: (issueSummary: string, issueDescription: string) => Promise<void>;
  onRefreshHealth: () => Promise<void>;
};

export default function SupportTicketSection({
  loading,
  canCreateTicket,
  supportHealth,
  supportHealthLoading,
  supportTickets,
  supportNotifications,
  onCreateTicket,
  onRefreshHealth,
}: SupportTicketSectionProps) {
  const [issueSummary, setIssueSummary] = useState('');
  const [issueDescription, setIssueDescription] = useState('');

  const submitTicket = async () => {
    const summary = issueSummary.trim();
    const description = issueDescription.trim();

    if (!summary || !description) {
      return;
    }

    await onCreateTicket(summary, description);
    setIssueSummary('');
    setIssueDescription('');
  };

  const healthBadgeClass = supportHealth?.active
    ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200'
    : 'border-amber-400/40 bg-amber-500/10 text-amber-200';

  const ticketButtonDisabled = loading || !canCreateTicket;

  return (
    <section className="mb-5 overflow-hidden rounded-3xl border border-white/15 bg-gradient-to-br from-slate-900/95 via-slate-900/85 to-cyan-950/35 backdrop-blur-xl shadow-[0_24px_80px_rgba(2,6,23,0.45)]">
      <div className="border-b border-white/10 bg-white/5 px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-200">n8n Support Ticket Desk</p>
            <p className="mt-1 text-xs text-slate-300">Submit production incidents through automation with reliable fallback handling.</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${healthBadgeClass}`}>
              {supportHealth?.active ? 'n8n Online' : 'Fallback Mode'}
            </span>
            <button
              type="button"
              onClick={() => {
                void onRefreshHealth();
              }}
              disabled={supportHealthLoading}
              className="rounded-full border border-slate-500/60 bg-slate-900/60 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-200 transition hover:border-cyan-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {supportHealthLoading ? 'Checking...' : 'Refresh Status'}
            </button>
          </div>
        </div>
        {supportHealth ? (
          <div className="mt-2 space-y-1">
            <p className="text-[11px] text-slate-400/95">
              {supportHealth.message}
              {supportHealth.http_status ? ` (HTTP ${supportHealth.http_status})` : ''}
            </p>
            <p className="text-[11px] text-slate-300">
              Email webhook configured:{' '}
              <span
                className={
                  supportHealth.email_webhook_configured ? 'font-semibold text-emerald-300' : 'font-semibold text-amber-300'
                }
              >
                {supportHealth.email_webhook_configured ? 'Yes' : 'No'}
              </span>
            </p>
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-4 p-4 sm:p-5 lg:grid-cols-[1.2fr_0.8fr]">
        <div>
          <label htmlFor="support-issue-summary" className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-300">
            Issue Summary
          </label>
          <input
            id="support-issue-summary"
            value={issueSummary}
            onChange={(event) => setIssueSummary(event.target.value)}
            className="w-full rounded-xl border border-white/15 bg-slate-950/75 px-3 py-2 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/20"
            placeholder="Users cannot login after latest deployment"
          />

          <label htmlFor="support-issue-description" className="mb-1 mt-3 block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-300">
            Issue Description
          </label>
          <textarea
            id="support-issue-description"
            rows={5}
            value={issueDescription}
            onChange={(event) => setIssueDescription(event.target.value)}
            className="w-full resize-none rounded-xl border border-white/15 bg-slate-950/75 px-3 py-2 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/20"
            placeholder="Describe impact, affected users, error details, and troubleshooting already attempted."
          />

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                void submitTicket();
              }}
              disabled={ticketButtonDisabled}
              className="rounded-full border border-cyan-300/70 bg-gradient-to-r from-cyan-500 to-blue-500 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-white shadow-[0_8px_24px_rgba(6,182,212,0.35)] transition hover:from-cyan-400 hover:to-blue-400 disabled:cursor-not-allowed disabled:border-slate-600 disabled:bg-slate-700 disabled:shadow-none"
            >
              {loading ? 'Creating ticket...' : 'Create n8n Support Ticket'}
            </button>
            {!canCreateTicket ? <span className="text-[11px] text-amber-300">Start or select a chat first.</span> : null}
          </div>
        </div>

        <div className="space-y-3">
          <div className="rounded-2xl border border-white/15 bg-white/5 p-3 backdrop-blur-md">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-cyan-200">Recent Tickets</p>
            {supportTickets.length > 0 ? (
              <ul className="mt-2 space-y-2 text-[11px] text-slate-200">
                {supportTickets.slice(0, 4).map((ticket) => (
                  <li key={ticket.ticket_id} className="rounded-lg border border-white/10 bg-slate-900/65 px-2 py-1.5">
                    <p className="font-semibold text-slate-100">{ticket.ticket_id}</p>
                    <p className="mt-0.5 text-slate-400">
                      {ticket.status} | {ticket.priority} | {ticket.category}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[11px] text-slate-500">No tickets yet for this chat.</p>
            )}
          </div>

          <div className="rounded-2xl border border-white/15 bg-white/5 p-3 backdrop-blur-md">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-cyan-200">Live Updates</p>
            {supportNotifications.length > 0 ? (
              <ul className="mt-2 space-y-2 text-[11px] text-slate-200">
                {supportNotifications.slice(0, 3).map((event, index) => (
                  <li key={`${event.ticket_id}-${event.timestamp}-${index}`} className="rounded-lg border border-white/10 bg-slate-900/65 px-2 py-1.5">
                    <p className="font-semibold text-slate-100">{event.ticket_id}</p>
                    <p className="mt-0.5 text-slate-400">{event.status} | {event.message}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-[11px] text-slate-500">Waiting for status updates.</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
