from pydantic_settings import BaseSettings, SettingsConfigDict


class Env(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    DJANGO_SECRET_KEY: str = "dev-insecure-change-me"
    DJANGO_DEBUG: bool = True
    DJANGO_ALLOWED_HOSTS: list[str] = ["*"]

    POSTGRES_DB: str = "stage"
    POSTGRES_USER: str = "stage"
    POSTGRES_PASSWORD: str = "stage"
    POSTGRES_HOST: str = "localhost"
    POSTGRES_PORT: int = 5432

    GITHUB_ADMIN_PAT: str = "ghp_REPLACE_ME"
    GITHUB_OAUTH_CLIENT_ID: str = "Iv1.REPLACE_ME"
    GITHUB_OAUTH_CLIENT_SECRET: str = "REPLACE_ME"
    GITHUB_API_BASE: str = "https://api.github.com"


env = Env()
