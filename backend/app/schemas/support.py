from datetime import datetime

from pydantic import BaseModel, Field
from pydantic import model_validator


class SupportTicketCreateRequest(BaseModel):
    issue_summary: str | None = Field(default=None, max_length=300)
    issue_description: str | None = Field(default=None, max_length=6000)
    issue: str | None = Field(default=None, max_length=6000)
    thread_id: int | None = None

    @model_validator(mode='before')
    @classmethod
    def normalize_legacy_payload(cls, data):
        if not isinstance(data, dict):
            return data

        issue_text = str(data.get('issue') or '').strip()
        summary = str(data.get('issue_summary') or '').strip()
        description = str(data.get('issue_description') or '').strip()

        if not summary and issue_text:
            summary = issue_text
        if not description and issue_text:
            description = issue_text

        data['issue_summary'] = summary
        data['issue_description'] = description
        return data

    @model_validator(mode='after')
    def validate_lengths(self):
        summary = (self.issue_summary or '').strip()
        description = (self.issue_description or '').strip()

        if len(summary) < 5:
            raise ValueError('issue_summary: String should have at least 5 characters')
        if len(description) < 10:
            raise ValueError('issue_description: String should have at least 10 characters')

        self.issue_summary = summary
        self.issue_description = description
        return self


class SupportTicketResponse(BaseModel):
    ticket_id: str
    user_name: str
    user_email: str
    issue_summary: str
    issue_description: str
    category: str
    priority: str
    status: str
    created_at: datetime
    updated_at: datetime
    message: str = 'Your ticket has been created successfully.'


class SupportTicketListResponse(BaseModel):
    tickets: list[SupportTicketResponse] = Field(default_factory=list)


class SupportStatusCallbackRequest(BaseModel):
    ticket_id: str
    status: str
    message: str = 'Ticket status updated.'
    category: str | None = None
    priority: str | None = None


class SupportNotificationEvent(BaseModel):
    event_type: str
    ticket_id: str
    status: str
    message: str
    timestamp: datetime


class SupportWorkflowHealthResponse(BaseModel):
    configured: bool
    active: bool
    fallback: bool
    email_webhook_configured: bool
    reachable: bool
    http_status: int | None = None
    webhook_url: str
    message: str
