from pathlib import Path
from urllib.parse import urlparse, urlunparse

from dotenv import dotenv_values
from pydantic import AnyUrl, Field
from pydantic_settings import BaseSettings


ENV_FILE = Path(__file__).resolve().parents[2] / '.env'


class Settings(BaseSettings):
    APP_NAME: str = Field('Amzur AI Chat', env='APP_NAME')
    APP_VERSION: str = Field('0.1.0', env='APP_VERSION')
    ENVIRONMENT: str = Field('development', env='ENVIRONMENT')

    DATABASE_URL: str = Field('postgresql+asyncpg://localhost/amzur_ai_chat', env='DATABASE_URL')
    SECRET_KEY: str = Field('replace-me', env='SECRET_KEY')
    JWT_EXPIRE_MINUTES: int = Field(60, env='JWT_EXPIRE_MINUTES')

    FRONTEND_URL: AnyUrl = Field('http://localhost:4173', env='FRONTEND_URL')

    LLM_PROVIDER: str = Field('openai', env='LLM_PROVIDER')
    LLM_MODEL: str = Field('gpt-4o', env='LLM_MODEL')
    LLM_API_KEY: str = Field('', env='LLM_API_KEY')
    LLM_API_BASE_URL: str = Field('https://api.openai.com/v1', env='LLM_API_BASE_URL')
    LLM_TEMPERATURE: float = Field(0.2, env='LLM_TEMPERATURE')
    SPREADSHEET_LLM_MODEL: str = Field('gpt-4o-mini', env='SPREADSHEET_LLM_MODEL')
    SPREADSHEET_LLM_TEMPERATURE: float = Field(0.0, env='SPREADSHEET_LLM_TEMPERATURE')
    RESEARCH_LLM_MODEL: str = Field('gpt-4o', env='RESEARCH_LLM_MODEL')
    RESEARCH_LLM_TEMPERATURE: float = Field(0.1, env='RESEARCH_LLM_TEMPERATURE')
    RESEARCH_MAX_ITERATIONS: int = Field(3, env='RESEARCH_MAX_ITERATIONS')
    N8N_SUPPORT_WEBHOOK_URL: str = Field(
        'http://127.0.0.1:5678/webhook/ai-support-ticket-routing-escalation',
        env='N8N_SUPPORT_WEBHOOK_URL',
    )
    N8N_SUPPORT_API_KEY: str = Field('', env='N8N_SUPPORT_API_KEY')
    N8N_SUPPORT_CALLBACK_URL: str = Field(
        'http://127.0.0.1:8010/api/support/tickets/status-callback',
        env='N8N_SUPPORT_CALLBACK_URL',
    )
    N8N_SUPPORT_CALLBACK_TOKEN: str = Field('change-me', env='N8N_SUPPORT_CALLBACK_TOKEN')
    N8N_SUPPORT_TIMEOUT_SECONDS: float = Field(30.0, env='N8N_SUPPORT_TIMEOUT_SECONDS')
    N8N_SUPPORT_MAX_RETRIES: int = Field(3, env='N8N_SUPPORT_MAX_RETRIES')
    N8N_SUPPORT_EMAIL_WEBHOOK_URL: str = Field('', env='N8N_SUPPORT_EMAIL_WEBHOOK_URL')
    N8N_WEBHOOK_URL: str = Field('', env='N8N_WEBHOOK_URL')
    N8N_API_KEY: str = Field('', env='N8N_API_KEY')
    N8N_STATUS_WEBHOOK_URL: str = Field('', env='N8N_STATUS_WEBHOOK_URL')
    GEMINI_API_KEY: str = Field('', env='GEMINI_API_KEY')
    IMAGE_GEN_MODEL: str = Field('', env='IMAGE_GEN_MODEL')
    GEMINI_IMAGE_MODEL: str = Field(
        'gemini-2.0-flash-preview-image-generation',
        env='GEMINI_IMAGE_MODEL',
    )
    GEMINI_IMAGE_TIMEOUT_SECONDS: float = Field(90.0, env='GEMINI_IMAGE_TIMEOUT_SECONDS')
    GEMINI_MAX_PROMPT_CHARS: int = Field(800, env='GEMINI_MAX_PROMPT_CHARS')

    LITELLM_PROXY_URL: AnyUrl = Field('https://litellm.amzur.com', env='LITELLM_PROXY_URL')
    LITELLM_API_KEY: str = Field('', env='LITELLM_API_KEY')
    LITELLM_EMBEDDING_MODEL: str = Field('text-embedding-3-large', env='LITELLM_EMBEDDING_MODEL')

    @property
    def effective_n8n_support_webhook_url(self) -> str:
        configured = (self.N8N_SUPPORT_WEBHOOK_URL or '').strip()
        if not configured:
            configured = (self.N8N_WEBHOOK_URL or '').strip()
        if not configured:
            return ''

        parsed = urlparse(configured)
        if not parsed.scheme or not parsed.netloc:
            return configured

        expected_suffix = '/webhook/ai-support-ticket-routing-escalation'
        next_path = parsed.path or ''
        next_path = next_path.replace('/webhook-test/', '/webhook/')
        if next_path.endswith('/support-ticket-smart-route'):
            next_path = next_path[: -len('/support-ticket-smart-route')] + '/ai-support-ticket-routing-escalation'
        if '/webhook/' in next_path and not next_path.endswith('/ai-support-ticket-routing-escalation'):
            base = next_path.split('/webhook/')[0]
            next_path = f"{base}{expected_suffix}"
        if '/webhook/' not in next_path:
            next_path = expected_suffix

        normalized = parsed._replace(path=next_path)
        return urlunparse(normalized)

    @property
    def effective_n8n_support_email_webhook_url(self) -> str:
        file_values = dotenv_values(str(ENV_FILE))
        configured_from_file = file_values.get('N8N_SUPPORT_EMAIL_WEBHOOK_URL')
        if isinstance(configured_from_file, str) and configured_from_file.strip():
            return configured_from_file.strip()

        return (self.N8N_SUPPORT_EMAIL_WEBHOOK_URL or '').strip()

    @property
    def effective_llm_api_key(self) -> str:
        return self.LLM_API_KEY or self.LITELLM_API_KEY

    @property
    def effective_llm_api_base_url(self) -> str:
        file_values = dotenv_values(str(ENV_FILE))
        configured_api_base = file_values.get('LLM_API_BASE_URL')
        if isinstance(configured_api_base, str) and configured_api_base.strip():
            return configured_api_base.strip()

        if self.LLM_PROVIDER.strip().lower() == 'litellm':
            return str(self.LITELLM_PROXY_URL)

        return self.LLM_API_BASE_URL

    @property
    def effective_gemini_api_key(self) -> str:
        return self.GEMINI_API_KEY

    @property
    def effective_gemini_image_model(self) -> str:
        if self.IMAGE_GEN_MODEL and self.IMAGE_GEN_MODEL.strip():
            return self.IMAGE_GEN_MODEL.strip()

        if self.GEMINI_IMAGE_MODEL and self.GEMINI_IMAGE_MODEL.strip():
            return self.GEMINI_IMAGE_MODEL.strip()

        return 'gemini-2.0-flash-preview-image-generation'

    GOOGLE_OAUTH_CLIENT_ID: str | None = Field(None, env='GOOGLE_OAUTH_CLIENT_ID')
    GOOGLE_OAUTH_CLIENT_SECRET: str | None = Field(None, env='GOOGLE_OAUTH_CLIENT_SECRET')
    GOOGLE_OAUTH_REDIRECT_URI: str | None = Field(None, env='GOOGLE_OAUTH_REDIRECT_URI')
    GOOGLE_SERVICE_ACCOUNT_JSON: str | None = Field(None, env='GOOGLE_SERVICE_ACCOUNT_JSON')
    GOOGLE_SERVICE_ACCOUNT_FILE: str | None = Field(None, env='GOOGLE_SERVICE_ACCOUNT_FILE')

    ATTACHMENTS_DIR: str = Field('backend/storage/attachments', env='ATTACHMENTS_DIR')
    MAX_ATTACHMENT_SIZE_MB: int = Field(20, env='MAX_ATTACHMENT_SIZE_MB')
    MAX_ATTACHMENTS_PER_MESSAGE: int = Field(8, env='MAX_ATTACHMENTS_PER_MESSAGE')

    @property
    def effective_frontend_origin(self) -> str:
        file_values = dotenv_values(str(ENV_FILE))
        file_value = file_values.get('FRONTEND_URL')
        if isinstance(file_value, str) and file_value.strip():
            return file_value.strip().rstrip('/')
        return str(self.FRONTEND_URL).rstrip('/')

    @property
    def effective_google_oauth_client_id(self) -> str | None:
        if self.GOOGLE_OAUTH_CLIENT_ID:
            return self.GOOGLE_OAUTH_CLIENT_ID

        # Support legacy/short alias used in some local .env files.
        env_client_id = dotenv_values(str(ENV_FILE)).get('CLIENT_ID')
        if isinstance(env_client_id, str) and env_client_id.strip():
            return env_client_id.strip()

        file_values = dotenv_values(str(ENV_FILE))
        value = file_values.get('GOOGLE_OAUTH_CLIENT_ID')
        if isinstance(value, str) and value.strip():
            return value.strip()
        return None

    @property
    def effective_google_oauth_redirect_uri(self) -> str:
        file_values = dotenv_values(str(ENV_FILE))
        file_value = file_values.get('GOOGLE_OAUTH_REDIRECT_URI')
        if isinstance(file_value, str) and file_value.strip():
            return file_value.strip()

        if self.GOOGLE_OAUTH_REDIRECT_URI and self.GOOGLE_OAUTH_REDIRECT_URI.strip():
            return self.GOOGLE_OAUTH_REDIRECT_URI.strip()

        return 'http://localhost:8010/api/auth/google/callback'

    class Config:
        env_file = str(ENV_FILE)
        env_file_encoding = 'utf-8'
        case_sensitive = True


settings = Settings()
