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

    GITHUB_APP_ID: int = 0
    GITHUB_APP_CLIENT_ID: str = "Iv1.REPLACE_ME"
    GITHUB_APP_CLIENT_SECRET: str = "REPLACE_ME"
    GITHUB_APP_PRIVATE_KEY: str = (
        "-----BEGIN RSA PRIVATE KEY-----\nREPLACE_ME\n-----END RSA PRIVATE KEY-----"
    )
    # App slug from the GitHub App's public page URL (github.com/apps/<slug>).
    # Used only to build the install URL surfaced when the repo-access gate
    # fails; left as a placeholder we check against to decide whether to emit it.
    GITHUB_APP_SLUG: str = "REPLACE_ME"
    GITHUB_API_BASE: str = "https://api.github.com"


env = Env()
