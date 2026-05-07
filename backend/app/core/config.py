from pathlib import Path

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

    LITELLM_PROXY_URL: AnyUrl = Field('https://litellm.amzur.com', env='LITELLM_PROXY_URL')
    LITELLM_API_KEY: str = Field('', env='LITELLM_API_KEY')
    LITELLM_EMBEDDING_MODEL: str = Field('text-embedding-3-large', env='LITELLM_EMBEDDING_MODEL')

    @property
    def effective_llm_api_key(self) -> str:
        return self.LLM_API_KEY or self.LITELLM_API_KEY

    @property
    def effective_llm_api_base_url(self) -> str:
        return self.LLM_API_BASE_URL or str(self.LITELLM_PROXY_URL)

    GOOGLE_OAUTH_CLIENT_ID: str | None = Field(None, env='GOOGLE_OAUTH_CLIENT_ID')
    GOOGLE_OAUTH_CLIENT_SECRET: str | None = Field(None, env='GOOGLE_OAUTH_CLIENT_SECRET')
    GOOGLE_OAUTH_REDIRECT_URI: str | None = Field(None, env='GOOGLE_OAUTH_REDIRECT_URI')

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
        if self.GOOGLE_OAUTH_REDIRECT_URI and self.GOOGLE_OAUTH_REDIRECT_URI.strip():
            return self.GOOGLE_OAUTH_REDIRECT_URI.strip()

        file_values = dotenv_values(str(ENV_FILE))
        file_value = file_values.get('GOOGLE_OAUTH_REDIRECT_URI')
        if isinstance(file_value, str) and file_value.strip():
            return file_value.strip()

        return 'http://localhost:8010/api/auth/google/callback'

    class Config:
        env_file = str(ENV_FILE)
        env_file_encoding = 'utf-8'
        case_sensitive = True


settings = Settings()
