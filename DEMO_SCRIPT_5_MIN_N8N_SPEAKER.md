# 5-Minute Speaker Script (Word-for-Word)

## 0:00 - 0:15 | Opening
"Good morning. I’m demonstrating my production-style n8n workflow called AI Support Ticket Routing and Escalation System.
This workflow receives a support request through a webhook, validates input, classifies with GPT-4o using LiteLLM, routes conditionally, stores to Supabase, sends Gmail notifications, and returns structured JSON with error handling."

## 0:15 - 0:45 | Show Workflow Architecture
"On this canvas, the flow is:
Webhook Trigger, then Validate Payload,
then AI Classification Agent with OpenAI Chat Model,
then Normalize Ticket Data,
then two decision layers:
Category branching and Priority branching,
then Store Ticket in Supabase,
then Gmail notifications,
and finally structured webhook response.
This satisfies all required complexity criteria:
branching, transformations, AI integration, database persistence, triggered execution, and graceful error handling."

## 0:45 - 1:00 | Transition to Live Test
"Now I’ll trigger the workflow with Postman using a high-priority real-world issue."

## 1:00 - 1:40 | High-Priority Postman Request
"I’m sending this payload now."

```json
{
  "user_email": "gnr.mca@gmail.com",
  "issue": "Production server is down and customers cannot login. This is urgent"
}
```

"Expected behavior is:
category should become Technical,
priority should become High,
urgent escalation email should trigger,
record should persist in Supabase,
and webhook should return success JSON."

## 1:40 - 2:10 | Read Response
"The response confirms success:
ticket ID was generated,
category and priority were assigned,
status is open,
and message says support ticket created successfully."

## 2:10 - 2:55 | Show Execution Path in n8n
"Now I’ll open the latest execution.
Here Validate Payload passed.
Here AI Classification Agent ran.
Here Normalize Ticket Data standardized values.
Here IF Category equals Technical took the Technical path.
Here IF Priority equals High took the urgent branch.
So routing is data-driven, not hardcoded."

## 2:55 - 3:30 | Show Supabase Persistence
"Now I’ll verify in Supabase using the tickets table.
The latest row includes required fields:
ticket_id,
user_email,
issue,
category,
priority,
status,
and created_at.
This proves database persistence and business data capture."

## 3:30 - 3:55 | Show Gmail Notifications
"Now I’ll verify Gmail.
I can see escalation notification for high-priority support handling,
and customer confirmation email for requester communication.
This proves both operational and user-facing notification logic."

## 3:55 - 4:35 | Show Validation Error Handling
"Next, I’ll test invalid input to prove graceful failure handling."

```json
{
  "user_email": "bad-email",
  "issue": ""
}
```

"Expected output is a structured validation error JSON.
The workflow rejects invalid email and empty issue,
returns HTTP 400,
and stops early without downstream side effects."

## 4:35 - 5:00 | Closing
"To conclude:
this workflow is production-style end-to-end automation.
It includes webhook trigger, AI classification, conditional branching, transformation, Supabase persistence, Gmail integration, and structured error handling.
This fully aligns with ATG n8n evaluation requirements. Thank you."

---

## Backup One-Liners (if timing issues happen)
- "I’ll open the previous successful execution to show the same branching path."
- "If email arrival is delayed, execution logs still confirm Gmail node success."
- "I can replay the same payload now to demonstrate deterministic routing again."
