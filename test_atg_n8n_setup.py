"""
ATG n8n Sidecar -- Pre-class Setup: Validation Test Suite
=========================================================
Covers every checklist item from the pre-class setup document AND the
final portfolio workflow submission criteria:

  Group 1  - Infrastructure reachability
  Group 2  - Environment / configuration files
  Group 3  - Database tables
  Group 4  - n8n workflow JSON assets
  Group 5  - Backend API (auth + support tickets, end-to-end)
  Group 6  - n8n / LiteLLM integration smoke tests
  Group 7  - Portfolio workflow: AI Support Ticket Automation & Smart Routing

Run from the backend directory:
    cd backend
    ..\\.venv\\Scripts\\python.exe -m pytest ..\test_atg_n8n_setup.py -v
"""

import json
import os
import sys
from pathlib import Path

import httpx
import pytest
import pytest_asyncio

# -- Path bootstrap -------------------------------------------------------
ROOT = Path(__file__).parent
BACKEND_DIR = ROOT / "backend"
sys.path.insert(0, str(BACKEND_DIR))

# -- Constants ------------------------------------------------------------
BACKEND_URL = os.getenv("BACKEND_URL", "http://127.0.0.1:8010")
FRONTEND_URL = "http://127.0.0.1:5173"
LITELLM_URL = "http://litellm.amzur.com:4000/v1"
N8N_CLOUD_URL = "https://nagarjunag.app.n8n.cloud"

ENV_FILE = BACKEND_DIR / ".env"
MCP_CONFIG = ROOT / ".vscode" / "mcp.json"
WORKFLOW_DIR = BACKEND_DIR / "n8n" / "workflows"

TEST_EMAIL = "atg_test_setup@amzur.com"
TEST_PASSWORD = "ATGSetup2026!"
ROUTING_WORKFLOW_FILE = WORKFLOW_DIR / "ai-support-ticket-routing.json"

# -- Shared HTTP client fixture -------------------------------------------
@pytest.fixture(scope="session")
def http():
    with httpx.Client(timeout=15, follow_redirects=True) as client:
        yield client


# =========================================================================
#  GROUP 1 - Infrastructure Reachability
# =========================================================================

class TestInfrastructureReachability:

    def test_TC01_backend_fastapi_is_running(self, http):
        """TC01: FastAPI backend responds at http://127.0.0.1:8010"""
        try:
            resp = http.post(
                f"{BACKEND_URL}/api/auth/login",
                json={},
            )
            assert resp.status_code in (200, 401, 422), (
                f"Expected 200/401/422 (server alive), got {resp.status_code}"
            )
        except httpx.ConnectError as exc:
            pytest.fail(f"Cannot reach backend at {BACKEND_URL}: {exc}")

    def test_TC02_frontend_vite_is_running(self, http):
        """TC02: Vite dev server responds at http://127.0.0.1:5173"""
        try:
            resp = http.get(FRONTEND_URL)
            assert resp.status_code == 200, f"Frontend returned {resp.status_code}"
            assert "html" in resp.headers.get("content-type", "").lower()
        except httpx.ConnectError as exc:
            pytest.fail(f"Cannot reach frontend at {FRONTEND_URL}: {exc}")

    def test_TC03_litellm_proxy_is_reachable(self, http):
        """TC03: LiteLLM proxy responds at http://litellm.amzur.com:4000/v1"""
        try:
            resp = http.get(f"{LITELLM_URL}/models",
                            headers={"Authorization": f"Bearer {_read_env('LITELLM_API_KEY')}"})
            assert resp.status_code in (200, 401, 403), (
                f"LiteLLM returned unexpected status {resp.status_code}"
            )
        except httpx.ConnectError as exc:
            pytest.fail(f"Cannot reach LiteLLM proxy: {exc}")

    def test_TC04_n8n_cloud_is_reachable(self, http):
        """TC04: n8n Cloud instance responds at nagarjunag.app.n8n.cloud"""
        try:
            resp = http.get(N8N_CLOUD_URL)
            assert resp.status_code < 500, f"n8n Cloud returned {resp.status_code}"
        except httpx.ConnectError as exc:
            pytest.fail(f"Cannot reach n8n Cloud at {N8N_CLOUD_URL}: {exc}")


# =========================================================================
#  GROUP 2 - Environment & Configuration Files
# =========================================================================

def _read_env(key: str) -> str:
    if not ENV_FILE.exists():
        return ""
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        if k.strip() == key:
            return v.strip()
    return ""


class TestConfiguration:

    def test_TC05_env_file_exists(self):
        """TC05: backend/.env file is present"""
        assert ENV_FILE.exists(), f"Missing: {ENV_FILE}"

    def test_TC06_database_url_configured(self):
        """TC06: DATABASE_URL is set and uses asyncpg (Supabase pooler)"""
        val = _read_env("DATABASE_URL")
        assert val, "DATABASE_URL is empty"
        assert "asyncpg" in val, "DATABASE_URL should use asyncpg driver"

    def test_TC07_litellm_api_key_configured(self):
        """TC07: LITELLM_API_KEY is set"""
        assert _read_env("LITELLM_API_KEY"), "LITELLM_API_KEY is empty"

    def test_TC08_litellm_proxy_url_configured(self):
        """TC08: LITELLM_PROXY_URL points to litellm.amzur.com"""
        val = _read_env("LITELLM_PROXY_URL")
        assert val, "LITELLM_PROXY_URL is empty"
        assert "litellm.amzur.com" in val, f"Got: {val}"

    def test_TC09_n8n_support_webhook_url_configured(self):
        """TC09: N8N_SUPPORT_WEBHOOK_URL is set"""
        assert _read_env("N8N_SUPPORT_WEBHOOK_URL"), "N8N_SUPPORT_WEBHOOK_URL is empty"

    def test_TC10_n8n_sidecar_vars_present(self):
        """TC10: N8N_WEBHOOK_URL, N8N_API_KEY, N8N_STATUS_WEBHOOK_URL exist"""
        content = ENV_FILE.read_text(encoding="utf-8")
        for var in ("N8N_WEBHOOK_URL", "N8N_API_KEY", "N8N_STATUS_WEBHOOK_URL"):
            assert var in content, f"{var} missing from backend/.env"

    def test_TC11_mcp_config_has_n8n_docs_server(self):
        """TC11: .vscode/mcp.json has n8n-docs MCP server"""
        assert MCP_CONFIG.exists(), f"Missing: {MCP_CONFIG}"
        data = json.loads(MCP_CONFIG.read_text(encoding="utf-8"))
        servers = data.get("servers", {})
        assert "n8n-docs" in servers, f"Found: {list(servers.keys())}"
        entry = servers["n8n-docs"]
        assert entry.get("type") == "http"
        assert "n8n.mcp.kapa.ai" in entry.get("url", "")

    def test_TC12_env_example_has_n8n_sidecar_vars(self):
        """TC12: backend/.env.example contains n8n sidecar variable names"""
        env_example = BACKEND_DIR / ".env.example"
        assert env_example.exists(), "backend/.env.example is missing"
        content = env_example.read_text(encoding="utf-8")
        for var in ("N8N_WEBHOOK_URL", "N8N_API_KEY", "N8N_STATUS_WEBHOOK_URL"):
            assert var in content, f"{var} missing from .env.example"


# =========================================================================
#  GROUP 3 - Database Tables
# =========================================================================

@pytest.mark.asyncio
class TestDatabaseTables:

    async def _check_table(self, table_name: str) -> bool:
        from sqlalchemy import text
        from sqlalchemy.ext.asyncio import create_async_engine
        from app.core.config import settings

        engine = create_async_engine(
            settings.DATABASE_URL,
            connect_args={
                'statement_cache_size': 0,
                'prepared_statement_cache_size': 0,
            },
        )
        try:
            async with engine.connect() as conn:
                result = await conn.execute(
                    text("SELECT EXISTS (SELECT 1 FROM information_schema.tables "
                         "WHERE table_schema = 'public' AND table_name = :tname)"),
                    {"tname": table_name},
                )
                return bool(result.scalar())
        finally:
            await engine.dispose()

    async def test_TC13_support_tickets_table_exists(self):
        """TC13: public.support_tickets exists"""
        assert await self._check_table("support_tickets"), \
            "public.support_tickets table missing"

    async def test_TC14_support_ticket_events_table_exists(self):
        """TC14: public.support_ticket_events exists"""
        assert await self._check_table("support_ticket_events"), \
            "public.support_ticket_events table missing"

    async def test_TC15_tickets_table_exists(self):
        """TC15: public.tickets exists (n8n workflow Postgres target)"""
        assert await self._check_table("tickets"), \
            "public.tickets table missing -- required by n8n Postgres nodes"

    async def test_TC16_users_table_exists(self):
        """TC16: public.users exists"""
        assert await self._check_table("users"), "public.users table missing"


# =========================================================================
#  GROUP 4 - n8n Workflow JSON Assets
# =========================================================================

class TestWorkflowAssets:

    def _load_workflow(self, filename: str) -> dict:
        path = WORKFLOW_DIR / filename
        assert path.exists(), f"Workflow file missing: {path}"
        return json.loads(path.read_text(encoding="utf-8"))

    def test_TC17_support_ticket_creation_workflow_exists(self):
        """TC17: support-ticket-creation.json is present"""
        data = self._load_workflow("support-ticket-creation.json")
        assert "nodes" in data

    def test_TC18_support_ticket_creation_has_webhook_trigger(self):
        """TC18: support-ticket-creation workflow has a Webhook node"""
        data = self._load_workflow("support-ticket-creation.json")
        types = [n.get("type", "") for n in data.get("nodes", [])]
        assert any("webhook" in t.lower() for t in types)

    def test_TC19_support_ticket_status_update_workflow_exists(self):
        """TC19: support-ticket-status-update.json is present"""
        data = self._load_workflow("support-ticket-status-update.json")
        assert "nodes" in data

    def test_TC20_status_update_workflow_sends_callback(self):
        """TC20: status-update workflow has an HTTP Request node"""
        data = self._load_workflow("support-ticket-status-update.json")
        types = [n.get("type", "") for n in data.get("nodes", [])]
        assert any("httpRequest" in t or "http" in t.lower() for t in types)

    def test_TC21_postgres_insert_is_disabled(self):
        """TC21: DB_Insert Postgres node is DISABLED in ticket-creation workflow"""
        data = self._load_workflow("support-ticket-creation.json")
        for node in data.get("nodes", []):
            if node.get("name") == "DB_Insert":
                assert node.get("disabled", False), "DB_Insert is ENABLED"
                return
        pytest.skip("DB_Insert node not found")


# =========================================================================
#  GROUP 5 - Backend API End-to-End (Auth + Support Tickets)
# =========================================================================

@pytest.fixture(scope="class")
def auth_token(http):
    payload = {"email": TEST_EMAIL, "password": TEST_PASSWORD}
    resp = http.post(f"{BACKEND_URL}/api/auth/login", json=payload)
    if resp.status_code == 200:
        return resp.json()["access_token"]
    resp = http.post(f"{BACKEND_URL}/api/auth/signup", json=payload)
    assert resp.status_code == 200, f"Signup failed ({resp.status_code}): {resp.text}"
    return resp.json()["access_token"]


class TestAPIEndToEnd:

    def test_TC22_auth_login_returns_token(self, http, auth_token):
        """TC22: Auth login/signup returns a JWT access token"""
        assert auth_token
        assert len(auth_token.split(".")) == 3, "Not a valid JWT"

    def test_TC23_create_support_ticket(self, http, auth_token):
        """TC23: POST /api/support/tickets creates a ticket (fallback path)"""
        headers = {"Authorization": f"Bearer {auth_token}"}
        payload = {
            "issue_summary": "ATG pre-class setup validation test ticket",
            "issue_description": (
                "This ticket was automatically created by the ATG n8n Sidecar "
                "pre-class setup validation suite. Safe to delete."
            ),
        }
        resp = http.post(f"{BACKEND_URL}/api/support/tickets",
                         json=payload, headers=headers)
        assert resp.status_code == 200, f"({resp.status_code}): {resp.text}"
        data = resp.json()
        assert "ticket_id" in data
        assert data["ticket_id"].startswith("TKT-")
        assert data["status"] == "open"
        assert data["category"]
        assert data["priority"] in ("low", "medium", "high", "critical")
        TestAPIEndToEnd._created_ticket_id = data["ticket_id"]
        print(f"\n  Created: {data['ticket_id']} cat={data['category']} pri={data['priority']}")

    def test_TC24_list_support_tickets_returns_created_ticket(self, http, auth_token):
        """TC24: GET /api/support/tickets returns the ticket created in TC23"""
        headers = {"Authorization": f"Bearer {auth_token}"}
        resp = http.get(f"{BACKEND_URL}/api/support/tickets", headers=headers)
        assert resp.status_code == 200, f"({resp.status_code}): {resp.text}"
        data = resp.json()
        assert "tickets" in data
        created_id = getattr(TestAPIEndToEnd, "_created_ticket_id", None)
        if created_id:
            ids = [t["ticket_id"] for t in data["tickets"]]
            assert created_id in ids, f"{created_id} not in {ids}"

    def test_TC25_status_callback_endpoint_reachable(self, http, auth_token):
        """TC25: POST /api/support/tickets/status-callback endpoint exists"""
        created_id = getattr(TestAPIEndToEnd, "_created_ticket_id", "TKT-TEST-0000")
        payload = {"ticket_id": created_id, "status": "in_progress",
                   "message": "ATG test callback"}
        resp = http.post(f"{BACKEND_URL}/api/support/tickets/status-callback",
                         json=payload)
        assert resp.status_code not in (404, 500), (
            f"Endpoint missing or crashed: {resp.status_code}"
        )

    def test_TC26_support_ticket_fallback_classification(self, http, auth_token):
        """TC26: Ticket gets category/priority without cloud n8n (fallback classifier)"""
        headers = {"Authorization": f"Bearer {auth_token}"}
        payload = {
            "issue_summary": "Cannot login to my account",
            "issue_description": (
                "I am unable to login. The system says my password is incorrect "
                "but I just reset it. Please help me recover my account access."
            ),
        }
        resp = http.post(f"{BACKEND_URL}/api/support/tickets",
                         json=payload, headers=headers)
        assert resp.status_code == 200, f"({resp.status_code}): {resp.text}"
        data = resp.json()
        assert data["category"], "category is empty even with fallback"
        assert data["priority"], "priority is empty even with fallback"
        print(f"\n  Fallback: cat={data['category']}, pri={data['priority']}")


# =========================================================================
#  GROUP 6 - LiteLLM Smoke Tests
# =========================================================================

class TestLiteLLMSmoke:

    def test_TC27_litellm_models_endpoint_responds(self, http):
        """TC27: LiteLLM /v1/models returns a model list"""
        api_key = _read_env("LITELLM_API_KEY")
        resp = http.get(f"{LITELLM_URL}/models",
                        headers={"Authorization": f"Bearer {api_key}"})
        assert resp.status_code == 200, f"({resp.status_code}): {resp.text[:300]}"
        data = resp.json()
        assert "data" in data and data["data"]
        print(f"\n  Models: {[m['id'] for m in data['data'][:5]]} ...")

    def test_TC28_litellm_gpt4o_chat_completion(self, http):
        """TC28: LiteLLM gpt-4o returns a valid chat completion response"""
        api_key = _read_env("LITELLM_API_KEY")
        payload = {
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": "Reply with exactly: ATG_SETUP_OK"}],
            "max_tokens": 20,
            "temperature": 0,
        }
        resp = http.post(f"{LITELLM_URL}/chat/completions", json=payload,
                         headers={"Authorization": f"Bearer {api_key}"}, timeout=30)
        assert resp.status_code == 200, f"({resp.status_code}): {resp.text[:300]}"
        data = resp.json()
        assert "choices" in data and data["choices"]
        content = data["choices"][0]["message"]["content"]
        assert "ATG_SETUP_OK" in content, f"Got: '{content}'"
        print(f"\n  Model response: {content.strip()}")


# =========================================================================
#  GROUP 7 - Portfolio Workflow: AI Support Ticket Automation & Smart Routing
#  Validates ALL 6 complexity requirements from the submission checklist.
# =========================================================================

class TestPortfolioWorkflow:
    """
    Validates the portfolio-level workflow against the 6 complexity requirements:
    Req 1: Conditional Logic     Req 4: Database I/O
    Req 2: Data Transformation   Req 5: Error Handling & Retry
    Req 3: Multiple Integrations Req 6: Triggered Execution
    """

    # -- Helpers ------------------------------------------------------------------

    def _load(self) -> dict:
        assert ROUTING_WORKFLOW_FILE.exists(), (
            f"Portfolio workflow file missing: {ROUTING_WORKFLOW_FILE}"
        )
        return json.loads(ROUTING_WORKFLOW_FILE.read_text(encoding="utf-8"))

    def _node(self, data: dict, node_id: str = None, node_name: str = None):
        for n in data.get("nodes", []):
            if node_id and n.get("id") == node_id:
                return n
            if node_name and n.get("name") == node_name:
                return n
        return None

    def _by_type(self, data: dict, substr: str) -> list:
        return [n for n in data.get("nodes", [])
                if substr.lower() in n.get("type", "").lower()]

    # -- File & Structure ---------------------------------------------------------

    def test_TC29_routing_workflow_file_exists(self):
        """TC29: ai-support-ticket-routing.json exists"""
        assert ROUTING_WORKFLOW_FILE.exists(), str(ROUTING_WORKFLOW_FILE)

    def test_TC30_workflow_name_correct(self):
        """TC30: Workflow has the correct descriptive name"""
        data = self._load()
        assert "AI Support Ticket" in data.get("name", ""), data.get("name")

    # -- Req 1: Conditional Logic (>=2 branch points) -----------------------------

    def test_TC31_has_two_if_nodes(self):
        """TC31 [Req 1]: At least 2 IF nodes (priority + category routing)"""
        data = self._load()
        if_nodes = self._by_type(data, "n8n-nodes-base.if")
        assert len(if_nodes) >= 2, (
            f"Need >=2 IF nodes, found {len(if_nodes)}: {[n['name'] for n in if_nodes]}"
        )

    def test_TC32_priority_if_routes_on_high(self):
        """TC32 [Req 1]: Priority IF node branches on 'High'"""
        data = self._load()
        node = (self._node(data, node_id="IF_Priority_High") or
                self._node(data, node_name="IF Priority = High"))
        assert node is not None, "IF Priority = High node not found"
        assert "High" in json.dumps(node.get("parameters", {}))

    def test_TC33_category_if_routes_on_billing(self):
        """TC33 [Req 1]: Category IF node branches on 'Billing'"""
        data = self._load()
        node = (self._node(data, node_id="IF_Category_Billing") or
                self._node(data, node_name="IF Category = Billing"))
        assert node is not None, "IF Category = Billing node not found"
        assert "Billing" in json.dumps(node.get("parameters", {}))

    # -- Req 2: Data Transformation -----------------------------------------------

    def test_TC34_build_ticket_transforms_payload(self):
        """TC34 [Req 2]: Build Ticket Data Code node reshapes webhook payload"""
        data = self._load()
        node = (self._node(data, node_id="Build_Ticket_Data") or
                self._node(data, node_name="Build Ticket Data"))
        assert node is not None, "Build Ticket Data node not found"
        code = node.get("parameters", {}).get("jsCode", "")
        assert "ticket_id" in code, "Must generate ticket_id"
        assert "ai_prompt" in code, "Must build AI classification prompt"

    def test_TC35_extract_ai_result_parses_json(self):
        """TC35 [Req 2]: Extract AI Result Code node parses AI output with fallback"""
        data = self._load()
        node = (self._node(data, node_id="Extract_AI_Result") or
                self._node(data, node_name="Extract AI Result"))
        assert node is not None, "Extract AI Result node not found"
        code = node.get("parameters", {}).get("jsCode", "")
        assert "JSON.parse" in code
        assert "catch" in code.lower() or "fallback" in code.lower(), \
            "Must handle JSON parse failure with a fallback"

    def test_TC36_set_urgent_context_node_exists(self):
        """TC36 [Req 2]: Set node adds urgency fields on high-priority path"""
        data = self._load()
        node = (self._node(data, node_id="Set_Urgent_Context") or
                self._node(data, node_name="Set Urgent Context"))
        assert node is not None, "Set Urgent Context node not found"

    # -- Req 3: Multiple External Integrations ------------------------------------

    def test_TC37_has_ai_agent_node(self):
        """TC37 [Req 3]: AI Agent node (LiteLLM integration) present"""
        data = self._load()
        assert self._by_type(data, "langchain.agent"), "No AI Agent node found"

    def test_TC38_openai_model_uses_litellm_credential(self):
        """TC38 [Req 3]: OpenAI Chat Model uses LiteLLM (training) credential"""
        data = self._load()
        models = self._by_type(data, "lmChatOpenAi")
        assert models, "No OpenAI Chat Model sub-node found"
        cred = models[0].get("credentials", {}).get("openAiApi", {})
        assert "LiteLLM" in cred.get("name", ""), (
            f"Expected 'LiteLLM (training)', got: {cred.get('name', 'NOT SET')}"
        )

    def test_TC39_has_three_or_more_gmail_nodes(self):
        """TC39 [Req 3]: >=3 Gmail nodes (urgent + billing + standard + admin alert)"""
        data = self._load()
        gmail_nodes = self._by_type(data, "n8n-nodes-base.gmail")
        assert len(gmail_nodes) >= 3, (
            f"Found {len(gmail_nodes)}: {[n['name'] for n in gmail_nodes]}"
        )

    def test_TC40_has_postgres_nodes_for_supabase(self):
        """TC40 [Req 3+4]: >=2 PostgreSQL nodes (store ticket + log error)"""
        data = self._load()
        pg = self._by_type(data, "n8n-nodes-base.postgres")
        assert len(pg) >= 2, f"Found {len(pg)} Postgres nodes, need >=2"

    # -- Req 4: Database I/O ------------------------------------------------------

    def test_TC41_store_ticket_inserts_to_tickets_table(self):
        """TC41 [Req 4]: Store Ticket node INSERTs into public.tickets"""
        data = self._load()
        node = (self._node(data, node_id="Store_Ticket_Supabase") or
                self._node(data, node_name="Store Ticket in Supabase"))
        assert node is not None, "Store Ticket in Supabase node not found"
        query = node.get("parameters", {}).get("query", "")
        assert "INSERT" in query.upper(), "Store Ticket query must INSERT"
        assert "tickets" in query.lower(), "Store Ticket query must target 'tickets'"

    def test_TC42_error_log_persists_to_db(self):
        """TC42 [Req 4]: Error Log node writes to Supabase (audit trail)"""
        data = self._load()
        node = (self._node(data, node_id="Log_Error_DB") or
                self._node(data, node_name="Log Error to DB"))
        assert node is not None, "Log Error to DB node not found"
        cred = node.get("credentials", {}).get("postgres", {})
        assert "Postgres" in cred.get("name", ""), (
            f"Expected Postgres (training) credential, got: {cred}"
        )

    # -- Req 5: Error Handling & Retry --------------------------------------------

    def test_TC43_has_error_trigger(self):
        """TC43 [Req 5]: Error Trigger node catches all workflow failures"""
        data = self._load()
        assert self._by_type(data, "errorTrigger"), "No Error Trigger node found"

    def test_TC44_error_path_sends_admin_alert(self):
        """TC44 [Req 5]: Error path includes Gmail admin alert"""
        data = self._load()
        node = (self._node(data, node_id="Send_Admin_Alert") or
                self._node(data, node_name="Send Admin Alert"))
        assert node is not None, "Send Admin Alert node not found"

    def test_TC45_error_nodes_have_continue_on_fail(self):
        """TC45 [Req 5]: Error handler nodes use continueOnFail"""
        data = self._load()
        for nid in ("Log_Error_DB", "Send_Admin_Alert"):
            node = self._node(data, node_id=nid)
            if node:
                assert node.get("continueOnFail", False), (
                    f"'{node['name']}' should have continueOnFail=true"
                )

    def test_TC46_invalid_input_returns_400(self):
        """TC46 [Req 5]: Validate Input FALSE branch returns 400 error response"""
        data = self._load()
        conns = data.get("connections", {})
        validate_conns = conns.get("Validate Input", {}).get("main", [])
        assert len(validate_conns) >= 2, \
            "Validate Input must have TRUE (valid) + FALSE (invalid) outputs"
        assert validate_conns[1], "Validate Input FALSE branch is not connected"

    # -- Req 6: Triggered Execution -----------------------------------------------

    def test_TC47_has_webhook_trigger(self):
        """TC47 [Req 6]: Workflow starts with a Webhook trigger"""
        data = self._load()
        webhooks = self._by_type(data, "n8n-nodes-base.webhook")
        assert webhooks, "No Webhook trigger node found"
        path = webhooks[0].get("parameters", {}).get("path", "")
        assert path, "Webhook trigger has no path configured"
        print(f"\n  Webhook URL: /webhook/{path}")

    def test_TC48_webhook_in_response_node_mode(self):
        """TC48 [Req 6]: Webhook uses 'responseNode' mode for async response"""
        data = self._load()
        webhooks = self._by_type(data, "n8n-nodes-base.webhook")
        assert webhooks
        mode = webhooks[0].get("parameters", {}).get("responseMode", "")
        assert mode == "responseNode", f"Expected 'responseNode', got '{mode}'"

    # -- Quality: Documentation & Completeness ------------------------------------

    def test_TC49_has_sticky_notes_for_every_step(self):
        """TC49 [Quality]: >=5 sticky notes covering all major steps"""
        data = self._load()
        stickies = self._by_type(data, "stickyNote")
        assert len(stickies) >= 5, f"Need >=5 sticky notes, found {len(stickies)}"
        all_text = " ".join(
            n.get("parameters", {}).get("content", "") for n in stickies
        ).lower()
        for keyword in ("webhook", "ai", "routing", "database", "error"):
            assert keyword in all_text, f"No sticky note mentions '{keyword}'"

    def test_TC50_success_and_error_respond_nodes_exist(self):
        """TC50 [Quality]: Both Respond Success (200) and Respond Invalid (400) exist"""
        data = self._load()
        respond_nodes = self._by_type(data, "respondToWebhook")
        assert len(respond_nodes) >= 2, (
            f"Need >=2 Respond to Webhook nodes, found {len(respond_nodes)}"
        )
        full_text = json.dumps([n.get("parameters", {}) for n in respond_nodes])
        assert "400" in full_text, "No 400 error response node found"

    def test_TC51_all_key_nodes_connected(self):
        """TC51 [Quality]: All main flow nodes appear in the connections map"""
        data = self._load()
        conns = data.get("connections", {})
        required_sources = [
            "Webhook Trigger", "Validate Input", "Build Ticket Data",
            "AI Classification Agent", "Extract AI Result",
            "IF Priority = High", "IF Category = Billing",
            "Set Urgent Context", "Send Urgent Email",
            "Send Billing Email", "Send Standard Email",
            "Store Ticket in Supabase", "Error Trigger", "Log Error to DB",
        ]
        missing = [s for s in required_sources if s not in conns]
        assert not missing, f"Nodes with no outgoing connections: {missing}"


# =========================================================================
#  Entry point for direct execution
# =========================================================================

if __name__ == "__main__":
    import subprocess
    result = subprocess.run(
        [sys.executable, "-m", "pytest", __file__, "-v", "--tb=short"],
        cwd=str(ROOT),
    )
    sys.exit(result.returncode)
