import asyncio
import hashlib
import json
import logging
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

import httpx
from sqlalchemy import desc, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models import User
from app.models.support_ticket import SupportTicket, SupportTicketEvent
from app.schemas.support import SupportNotificationEvent

logger = logging.getLogger(__name__)


class SupportAutomationError(ValueError):
    pass


def _normalize_text(value: str) -> str:
    return re.sub(r'\s+', ' ', value).strip()


def _normalize_priority(value: str) -> str:
    normalized = _normalize_text(value).lower()
    if normalized in {'critical', 'high', 'medium', 'low'}:
        return normalized
    return 'medium'


def _normalize_status(value: str) -> str:
    normalized = _normalize_text(value).lower().replace(' ', '_')
    if normalized in {'open', 'in_progress', 'resolved', 'closed'}:
        return normalized
    return 'open'


def _build_dedupe_key(user_id: int, summary: str, description: str) -> str:
    seed = f"{user_id}|{_normalize_text(summary).lower()}|{_normalize_text(description).lower()}"
    return hashlib.sha256(seed.encode('utf-8')).hexdigest()


@dataclass
class TicketAutomationResult:
    ticket_id: str
    category: str
    priority: str
    status: str
    message: str
    used_fallback: bool = False
    customer_email_sent: bool | None = None


class SupportNotificationBroker:
    def __init__(self) -> None:
        self._queues: dict[int, list[asyncio.Queue[SupportNotificationEvent]]] = {}
        self._lock = asyncio.Lock()

    async def publish(self, user_id: int, event: SupportNotificationEvent) -> None:
        async with self._lock:
            queues = list(self._queues.get(user_id, []))
        for queue in queues:
            await queue.put(event)

    async def subscribe(self, user_id: int) -> AsyncIterator[SupportNotificationEvent]:
        queue: asyncio.Queue[SupportNotificationEvent] = asyncio.Queue()
        async with self._lock:
            self._queues.setdefault(user_id, []).append(queue)

        try:
            while True:
                event = await queue.get()
                yield event
        finally:
            async with self._lock:
                active = self._queues.get(user_id, [])
                if queue in active:
                    active.remove(queue)
                if not active and user_id in self._queues:
                    del self._queues[user_id]


notification_broker = SupportNotificationBroker()


def _classify_ticket(issue_summary: str, issue_description: str) -> tuple[str, str]:
    """Classify ticket category and priority based on content (n8n fallback)."""
    text = f"{issue_summary} {issue_description}".lower()
    
    # Category classification based on keywords
    if re.search(r'\b(bill|payment|invoice|charge|refund|fee|cost|price)\b', text):
        category = 'Billing'
    elif re.search(r'\b(login|password|otp|access|locked|sign in|authenticate|session)\b', text):
        category = 'Account Access'
    elif re.search(r'\b(bug|crash|error|exception|fail|broken|not work)\b', text):
        category = 'Bug Report'
    elif re.search(r'\b(feature|enhancement|request|improvement|suggest)\b', text):
        category = 'Feature Request'
    elif re.search(r'\b(slow|latency|performance|timeout|upload|speed|lag)\b', text):
        category = 'Technical Issue'
    else:
        category = 'General Inquiry'
    
    # Priority classification based on keywords
    if re.search(r'\b(urgent|critical|production down|data loss|security|breach|hack)\b', text):
        priority = 'Critical'
    elif re.search(r'\b(cannot|blocked|unable|outage|down|emergency)\b', text):
        priority = 'High'
    elif re.search(r'\b(minor|question|clarification|help|guide)\b', text):
        priority = 'Low'
    else:
        priority = 'Medium'
    
    return category, priority


def _generate_ticket_id() -> str:
    """Generate a ticket ID (n8n fallback)."""
    now = datetime.utcnow()
    date_part = now.strftime('%Y%m%d')
    random_part = str(hashlib.md5(str(datetime.utcnow().timestamp()).encode()).hexdigest()[:4]).upper()
    return f"TKT-{date_part}-{random_part}"


async def _call_n8n_ticket_create(payload: dict[str, Any]) -> TicketAutomationResult:
    """Call n8n webhook with fallback to local classification when n8n is unavailable."""
    webhook_url = settings.effective_n8n_support_webhook_url
    if not webhook_url:
        # n8n not configured - use fallback
        logger.info("N8N webhook not configured, using fallback ticket classification")
        return _fallback_classify_ticket(payload)

    timeout = httpx.Timeout(settings.N8N_SUPPORT_TIMEOUT_SECONDS)
    headers = {'Content-Type': 'application/json'}
    if settings.N8N_SUPPORT_API_KEY:
        headers['X-API-Key'] = settings.N8N_SUPPORT_API_KEY

    last_error: Exception | None = None
    for attempt in range(1, settings.N8N_SUPPORT_MAX_RETRIES + 1):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(
                    webhook_url,
                    headers=headers,
                    json=payload,
                )

            if response.status_code >= 400:
                raise SupportAutomationError(
                    f'n8n ticket workflow failed with status {response.status_code}: {response.text[:220]}'
                )

            data = response.json()
            if isinstance(data, dict):
                if data.get('success') is False or data.get('error') or data.get('error_code'):
                    detail = str(data.get('message') or data.get('error') or 'Unknown n8n workflow error')
                    raise SupportAutomationError(f'n8n ticket workflow returned an error: {detail}')

            ticket_id = str((data.get('ticket_id') if isinstance(data, dict) else '') or '').strip()
            if not ticket_id:
                # Some workflow variants return category/priority/status but omit ticket_id.
                # Keep n8n classification and generate an ID so downstream persistence remains stable.
                logger.warning('n8n response missing ticket_id; generating backend ticket id.')
                ticket_id = _generate_ticket_id()

            customer_email_sent: bool | None = None
            if isinstance(data, dict) and any(k in data for k in ['customer_email_sent', 'email_sent', 'customer_notified']):
                customer_email_sent = bool(
                    data.get('customer_email_sent') or data.get('email_sent') or data.get('customer_notified')
                )

            return TicketAutomationResult(
                ticket_id=ticket_id,
                category=str((data.get('category') if isinstance(data, dict) else '') or 'General Inquiry'),
                priority=_normalize_priority(str((data.get('priority') if isinstance(data, dict) else '') or 'medium')),
                status=_normalize_status(str((data.get('status') if isinstance(data, dict) else '') or 'open')),
                message=str((data.get('message') if isinstance(data, dict) else '') or 'Your ticket has been created successfully.'),
                used_fallback=False,
                customer_email_sent=customer_email_sent,
            )
        except Exception as exc:
            last_error = exc
            if attempt >= settings.N8N_SUPPORT_MAX_RETRIES:
                break
            await asyncio.sleep(min(0.6 * attempt, 2.0))

    # n8n failed - use fallback classification
    logger.warning(f"n8n unavailable ({last_error}), using fallback ticket classification")
    return _fallback_classify_ticket(payload)


def _fallback_classify_ticket(payload: dict[str, Any]) -> TicketAutomationResult:
    """Fallback ticket classification when n8n is unavailable."""
    issue_summary = payload.get('issue_summary', '')
    issue_description = payload.get('issue_description', '')
    
    category, priority = _classify_ticket(issue_summary, issue_description)
    ticket_id = _generate_ticket_id()
    
    return TicketAutomationResult(
        ticket_id=ticket_id,
        category=category,
        priority=_normalize_priority(priority),
        status='open',
        message='Your ticket has been created successfully.',
        used_fallback=True,
        customer_email_sent=False,
    )


async def get_support_workflow_health() -> dict[str, Any]:
    webhook_url = settings.effective_n8n_support_webhook_url.strip()
    email_webhook_configured = bool(settings.effective_n8n_support_email_webhook_url)
    if not webhook_url:
        return {
            'configured': False,
            'active': False,
            'fallback': True,
            'email_webhook_configured': email_webhook_configured,
            'reachable': False,
            'http_status': None,
            'webhook_url': '',
            'message': 'Support webhook is not configured; running in fallback mode.',
        }

    timeout = httpx.Timeout(min(settings.N8N_SUPPORT_TIMEOUT_SECONDS, 8.0))
    headers: dict[str, str] = {}
    if settings.N8N_SUPPORT_API_KEY:
        headers['X-API-Key'] = settings.N8N_SUPPORT_API_KEY

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.options(webhook_url, headers=headers)

        status = response.status_code
        reachable = status < 500
        active = reachable and status != 404 and '/webhook/' in webhook_url and '/webhook-test/' not in webhook_url
        return {
            'configured': True,
            'active': active,
            'fallback': not active,
            'email_webhook_configured': email_webhook_configured,
            'reachable': reachable,
            'http_status': status,
            'webhook_url': webhook_url,
            'message': (
                'n8n support workflow is reachable and active.'
                if active
                else 'n8n support workflow is configured but not active; fallback mode may be used.'
            ),
        }
    except Exception as exc:
        return {
            'configured': True,
            'active': False,
            'fallback': True,
            'email_webhook_configured': email_webhook_configured,
            'reachable': False,
            'http_status': None,
            'webhook_url': webhook_url,
            'message': f'n8n support workflow unreachable: {exc}',
        }


async def _trigger_confirmation_email_webhook(payload: dict[str, Any]) -> bool:
    webhook_url = settings.effective_n8n_support_email_webhook_url
    if not webhook_url:
        logger.warning('TICKET EMAIL: email webhook URL not configured — no confirmation email will be sent.')
        return False

    logger.warning('TICKET EMAIL: calling email webhook → %s', webhook_url)
    timeout = httpx.Timeout(min(settings.N8N_SUPPORT_TIMEOUT_SECONDS, 12.0))
    headers = {'Content-Type': 'application/json'}
    if settings.N8N_SUPPORT_API_KEY:
        headers['X-API-Key'] = settings.N8N_SUPPORT_API_KEY

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(webhook_url, headers=headers, json=payload)
        logger.warning('TICKET EMAIL: webhook response status=%s', response.status_code)
        if response.status_code >= 400:
            logger.warning(
                'Support confirmation email webhook returned status %s: %s',
                response.status_code,
                response.text[:200],
            )
            return False
        return True
    except Exception as exc:
        logger.warning('Support confirmation email webhook failed: %s', exc)
        return False


async def create_support_ticket_via_n8n(
    db: AsyncSession,
    user: User,
    issue_summary: str,
    issue_description: str,
    thread_id: int | None,
) -> tuple[SupportTicket, str]:
    summary = _normalize_text(issue_summary)
    description = _normalize_text(issue_description)

    if len(summary) < 5:
        raise SupportAutomationError('Please provide a clearer issue summary (at least 5 characters).')
    if len(description) < 10:
        raise SupportAutomationError('Please provide more issue details (at least 10 characters).')

    dedupe_key = _build_dedupe_key(user.id, summary, description)

    dedupe_stmt = (
        select(SupportTicket)
        .where(
            SupportTicket.user_id == user.id,
            SupportTicket.dedupe_key == dedupe_key,
            SupportTicket.status.in_(['open', 'in_progress', 'Open', 'In Progress']),
            SupportTicket.created_at >= datetime.utcnow() - timedelta(hours=24),
        )
        .order_by(desc(SupportTicket.created_at))
        .limit(1)
    )
    existing = (await db.execute(dedupe_stmt)).scalars().first()
    if existing:
        return existing, 'An existing open support ticket already exists. We reused that ticket.'

    n8n_payload = {
        'user_id': user.id,
        'user_name': user.email.split('@')[0],
        'user_email': user.email,
        'issue': f"{summary}. {description}" if description else summary,
        'issue_summary': summary,
        'issue_description': description,
        'thread_id': thread_id,
        'callback_url': settings.N8N_SUPPORT_CALLBACK_URL,
        'callback_token': settings.N8N_SUPPORT_CALLBACK_TOKEN,
    }
    result = await _call_n8n_ticket_create(n8n_payload)

    customer_message = result.message
    email_sent = result.customer_email_sent is True
    if not email_sent:
        email_sent = await _trigger_confirmation_email_webhook(
            {
                'ticket_id': result.ticket_id,
                'user_email': user.email,
                'user_name': user.email.split('@')[0],
                'issue_summary': summary,
                'issue_description': description,
                'category': result.category,
                'priority': result.priority,
                'status': result.status,
                'source': 'fallback' if result.used_fallback else 'n8n',
            }
        )

    email_delivery_audit = 'email-sent' if email_sent else 'fallback-unavailable'
    if email_sent:
        customer_message = 'Your ticket has been created successfully. A confirmation email has been sent.'
    else:
        customer_message = (
            'Your ticket has been created successfully, but email confirmation is unavailable right now.'
        )

    # Keep the portfolio `tickets` table populated even if n8n DB nodes are disabled
    # or the workflow is temporarily unreachable.
    try:
        async with db.begin_nested():
            await db.execute(
                text(
                    """
                    INSERT INTO tickets (
                        ticket_id,
                        user_email,
                        issue,
                        category,
                        priority,
                        status,
                        created_at
                    ) VALUES (
                        :ticket_id,
                        :user_email,
                        :issue,
                        :category,
                        :priority,
                        :status,
                        NOW()
                    )
                    ON CONFLICT (ticket_id) DO UPDATE SET
                        user_email = EXCLUDED.user_email,
                        issue = EXCLUDED.issue,
                        category = EXCLUDED.category,
                        priority = EXCLUDED.priority,
                        status = EXCLUDED.status
                    """
                ),
                {
                    'ticket_id': result.ticket_id,
                    'user_email': user.email,
                    'issue': f"{summary}. {description}" if description else summary,
                    'category': result.category,
                    'priority': result.priority,
                    'status': result.status,
                },
            )
    except Exception as exc:
        logger.warning('Unable to upsert public.tickets row for support ticket %s: %s', result.ticket_id, exc)

    ticket = SupportTicket(
        user_id=user.id,
        thread_id=thread_id,
        ticket_id=result.ticket_id,
        user_name=user.email.split('@')[0],
        user_email=user.email,
        issue_summary=summary,
        issue_description=description,
        category=result.category,
        priority=result.priority,
        status=result.status,
        dedupe_key=dedupe_key,
        source='n8n',
    )
    db.add(ticket)

    event = SupportTicketEvent(
        ticket_id=result.ticket_id,
        user_id=user.id,
        event_type='ticket_created',
        status=result.status,
        message=customer_message,
        payload_json=json.dumps(
            {
                'category': result.category,
                'priority': result.priority,
                'status': result.status,
            }
        ),
    )
    db.add(event)

    await db.commit()
    await db.refresh(ticket)

    await notification_broker.publish(
        user.id,
        SupportNotificationEvent(
            event_type='ticket_created',
            ticket_id=ticket.ticket_id,
            status=ticket.status,
            message=customer_message,
            timestamp=datetime.utcnow(),
        ),
    )

    logger.warning(
        'TICKET AUDIT: ticket_id=%s email_status=%s',
        ticket.ticket_id,
        email_delivery_audit,
    )

    return ticket, customer_message


async def list_support_tickets(
    db: AsyncSession,
    user_id: int,
    thread_id: int | None = None,
) -> list[SupportTicket]:
    stmt = select(SupportTicket).where(SupportTicket.user_id == user_id)
    if thread_id is not None:
        stmt = stmt.where(SupportTicket.thread_id == thread_id)
    stmt = stmt.order_by(desc(SupportTicket.updated_at)).limit(50)
    return list((await db.execute(stmt)).scalars().all())


async def process_status_callback(
    db: AsyncSession,
    ticket_id: str,
    status: str,
    message: str,
    category: str | None = None,
    priority: str | None = None,
) -> SupportTicket:
    stmt = select(SupportTicket).where(SupportTicket.ticket_id == ticket_id).limit(1)
    ticket = (await db.execute(stmt)).scalars().first()
    if not ticket:
        raise SupportAutomationError(f'Ticket not found: {ticket_id}')

    ticket.status = _normalize_text(status) or ticket.status
    if category:
        ticket.category = _normalize_text(category)
    if priority:
        ticket.priority = _normalize_text(priority)

    db.add(
        SupportTicketEvent(
            ticket_id=ticket.ticket_id,
            user_id=ticket.user_id,
            event_type='ticket_status_updated',
            status=ticket.status,
            message=_normalize_text(message) or 'Ticket status updated.',
            payload_json=json.dumps(
                {
                    'category': ticket.category,
                    'priority': ticket.priority,
                }
            ),
        )
    )

    await db.commit()
    await db.refresh(ticket)

    event_type = 'ticket_resolved' if ticket.status.lower() in {'resolved', 'closed'} else 'ticket_status_updated'
    await notification_broker.publish(
        ticket.user_id,
        SupportNotificationEvent(
            event_type=event_type,
            ticket_id=ticket.ticket_id,
            status=ticket.status,
            message=_normalize_text(message) or 'Ticket status updated.',
            timestamp=datetime.utcnow(),
        ),
    )

    return ticket
