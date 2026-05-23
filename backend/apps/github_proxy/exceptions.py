class GithubError(Exception):
    def __init__(self, status_code: int, message: str, body: dict | None = None) -> None:
        self.status_code = status_code
        self.message = message
        self.body = body or {}
        super().__init__(f"{status_code}: {message}")


class GithubNotFound(GithubError):
    pass


class GithubForbidden(GithubError):
    pass


class GithubConflict(GithubError):
    pass
