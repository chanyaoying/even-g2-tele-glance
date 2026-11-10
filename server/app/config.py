from functools import lru_cache
import logging
from pathlib import Path
from typing import Optional

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


REPO_ROOT = Path(__file__).resolve().parents[2]
logger = logging.getLogger(__name__)
PLACEHOLDER_SHARED_SECRETS = {"<enter-secret-token>", "my-secret-token", "changeme", "change-me", "secret"}
MIN_RECOMMENDED_SECRET_LENGTH = 16


class Settings(BaseSettings):
    backend_cors_origins: list[str] = Field(
        default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"],
        validation_alias="BACKEND_CORS_ORIGINS",
    )
    backend_cors_origin_regex: Optional[str] = Field(default=None, validation_alias="BACKEND_CORS_ORIGIN_REGEX")
    tailscale_enabled: bool = Field(default=True, validation_alias="TAILSCALE_ENABLED")
    whisper_model: str = Field(default="base", validation_alias="WHISPER_MODEL")
    whisper_device: str = Field(default="auto", validation_alias="WHISPER_DEVICE")
    whisper_compute_type: str = Field(default="int8", validation_alias="WHISPER_COMPUTE_TYPE")
    whisper_beam_size: int = Field(default=1, validation_alias="WHISPER_BEAM_SIZE")
    whisper_best_of: int = Field(default=1, validation_alias="WHISPER_BEST_OF")
    whisper_temperature: float = Field(default=0.0, validation_alias="WHISPER_TEMPERATURE")
    whisper_condition_on_previous_text: bool = Field(
        default=False,
        validation_alias="WHISPER_CONDITION_ON_PREVIOUS_TEXT",
    )
    whisper_preload: bool = Field(default=True, validation_alias="WHISPER_PRELOAD")
    whisper_model_revision: Optional[str] = Field(default=None, validation_alias="WHISPER_MODEL_REVISION")
    # Optional hosted transcription. When a key is set, recordings go to Groq's Whisper first and fall back
    # to the local model if Groq fails. Audio leaves the machine in that case.
    groq_api_key: Optional[str] = Field(default=None, validation_alias="GROQ_API_KEY")
    groq_stt_model: str = Field(default="whisper-large-v3-turbo", validation_alias="GROQ_STT_MODEL")
    groq_stt_timeout_seconds: float = Field(default=20.0, validation_alias="GROQ_STT_TIMEOUT_SECONDS")
    transcribe_max_upload_bytes: int = Field(default=2_000_000, validation_alias="TRANSCRIBE_MAX_UPLOAD_BYTES")
    # Recordings allowed in flight at once (each waits up to 30 s for a slot, then gets 503) and their length.
    transcribe_max_concurrent: int = Field(default=2, validation_alias="TRANSCRIBE_MAX_CONCURRENT")
    transcribe_max_seconds: float = Field(default=120.0, validation_alias="TRANSCRIBE_MAX_SECONDS")
    # Every other request body is a small encrypted JSON envelope (a 4096-character message is ~25 KB).
    request_max_json_bytes: int = Field(default=64 * 1024, validation_alias="REQUEST_MAX_JSON_BYTES")
    teleglance_shared_secret: Optional[str] = Field(default=None, validation_alias="TELEGLANCE_SHARED_SECRET")

    model_config = SettingsConfigDict(env_file=REPO_ROOT / ".env", extra="ignore")

    @field_validator("teleglance_shared_secret")
    @classmethod
    def check_shared_secret(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        stripped = value.strip()
        if stripped.lower() in PLACEHOLDER_SHARED_SECRETS or (stripped.startswith("<") and stripped.endswith(">")):
            raise ValueError(
                "TELEGLANCE_SHARED_SECRET is still a placeholder. Generate a real one with: openssl rand -base64 32"
            )
        if 0 < len(stripped) < MIN_RECOMMENDED_SECRET_LENGTH:
            logger.warning(
                "TELEGLANCE_SHARED_SECRET is shorter than %d characters; use `openssl rand -base64 32`.",
                MIN_RECOMMENDED_SECRET_LENGTH,
            )
        return value

    @field_validator("backend_cors_origins", mode="before")
    @classmethod
    def split_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value

    @model_validator(mode="after")
    def resolve_paths(self) -> "Settings":
        if self.tailscale_enabled and self.backend_cors_origin_regex is None:
            self.backend_cors_origin_regex = r"^https?://(localhost|127\.0\.0\.1|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.\d{1,3}\.\d{1,3})(:\d+)?$"
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
