# 5-Minute Demo Script: AI Support Ticket Routing & Escalation System

## Goal (what to say in 15 seconds)
"This demo shows a production-style n8n workflow that receives support tickets from a webhook, validates input, classifies with GPT-4o via LiteLLM, routes conditionally by category and priority, stores to Supabase Postgres, sends Gmail notifications, and returns structured JSON with full error handling."

---

## Pre-Demo Setup Checklist (30 seconds)
- Workflow in n8n: **AI Support Ticket Routing & Escalation System**
- Workflow status: **Active**
- Credentials connected:
  - LiteLLM (training)
  - Postgres (training)
  - Gmail (training)
- Webhook endpoint path in workflow: `/webhook/ai-support-ticket-routing-escalation`
- Keep these tabs open:
  - n8n canvas + Executions
  - Postman
  - Supabase table viewer (`tickets`)
  - Gmail inbox

---

## Demo Flow (under 5 minutes)

### 1) Show Architecture on Canvas (0:00 - 0:45)
Say:
"The flow is: Webhook Trigger -> Validate Payload -> AI Classification Agent + OpenAI Chat Model -> Normalize Ticket Data -> Category branch -> DB insert -> Priority branch -> Gmail notifications -> Webhook response."

Point to:
- Webhook Trigger
- Validate Payload
- AI Classification Agent
- OpenAI Chat Model
- IF Category = Technical
- IF Priority = High
- Store Ticket in Supabase
- Send Urgent Escalation Email / Send Customer Confirmation
- Respond Success
- Error response nodes

Say:
"This satisfies all complexity criteria: branching, transformations, AI integration, DB persistence, webhook trigger, and graceful error handling."

### 2) Execute High-Priority Test in Postman (0:45 - 2:00)
POST to your production webhook URL with JSON:

```json
{
  "user_email": "test@gmail.com",
  "issue": "Production server is down and customers cannot login. This is urgent"
}
```

Say while sending:
"This payload should classify as Technical and High priority, trigger urgent escalation, persist to Supabase, and return structured success JSON."

Expected response:

```json
{
  "ticket_id": "TICK-...",
  "category": "Technical",
  "priority": "High",
  "status": "open",
  "message": "Support ticket created successfully"
}
```

### 3) Prove Branching + AI in n8n Executions (2:00 - 3:00)
Open latest execution and show:
- Validate Payload passed
- AI Classification Agent output parsed
- Normalize Ticket Data produced standardized values
- IF Category = Technical took Technical branch
- IF Priority = High took urgent branch

Say:
"You can see both conditional branches are data-driven from AI + normalization logic, not hardcoded routing."

### 4) Prove Database Persistence in Supabase (3:00 - 3:35)
Run or show query:

```sql
SELECT ticket_id, user_email, issue, category, priority, status, created_at
FROM tickets
ORDER BY created_at DESC
LIMIT 3;
```

Say:
"The inserted record includes required fields: ticket_id, user_email, issue, category, priority, status, created_at."

### 5) Prove Gmail Integration (3:35 - 4:05)
Show inbox:
- Urgent escalation email received (support/escalation mailbox)
- Customer confirmation email received

Say:
"High priority triggered escalation mail; confirmation is also sent to the customer."

### 6) Show Error Handling Path Quickly (4:05 - 4:45)
Send invalid payload:

```json
{
  "user_email": "bad-email",
  "issue": ""
}
```

Expected validation response (400):

```json
{
  "success": false,
  "error_code": "VALIDATION_ERROR",
  "message": "Invalid request payload",
  "details": [
    "issue must not be empty",
    "user_email must be a valid email"
  ]
}
```

Say:
"Invalid inputs are rejected immediately with structured JSON. Similar structured branches exist for DB insert failure and Gmail failures."

### 7) Close Strongly (4:45 - 5:00)
Say:
"This workflow is production-style: AI classification with GPT-4o, dual branching, transformations, persistence, notifications, and robust error responses. It is fully aligned to ATG n8n evaluation criteria."

---

## Backup Lines If Something Delays
- "I’ll open the last successful execution to show the exact branch path and outputs."
- "Even if email delivery is delayed, node execution status confirms Gmail integration path was triggered."
- "If webhook latency occurs, I’ll replay the same payload from Postman and show deterministic routing."

---

## Quick Demo Commands/Snippets (optional copy)

High-priority payload:
```json
{
  "user_email": "test@gmail.com",
  "issue": "Payment failed multiple times and this is urgent"
}
```

Medium/normal payload:
```json
{
  "user_email": "test@gmail.com",
  "issue": "I have a general question about plan features"
}
```

Validation-fail payload:
```json
{
  "user_email": "invalid",
  "issue": ""
}
```
