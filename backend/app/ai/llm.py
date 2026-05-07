from langchain.chat_models import init_chat_model

from app.core.config import settings


llm = init_chat_model(
    model=settings.LLM_MODEL,
    model_provider=settings.LLM_PROVIDER,
    api_key=settings.effective_llm_api_key,
    api_base=settings.effective_llm_api_base_url,
    temperature=settings.LLM_TEMPERATURE,
)
