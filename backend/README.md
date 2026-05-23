# Stage

After having worked with Django in a few personal and work projects and having started more or less always from the same base I've decided to create this starter template.

The overall template is heavily influenced by the [HackSoft Django Styleguide](https://github.com/HackSoftware/Django-Styleguide). I've updated elements in a few places to match my workflow or issues we experienced. The most recent edition are the inclusion of a very light `CLAUDE.md` file and some [skills](https://github.com/mattpocock/skills) from the wonderful repo of Matt Pocock.


## Requirements

- [uv](https://docs.astral.sh/uv/)
- [just](https://github.com/casey/just)
- [Docker](https://www.docker.com/)
- [graphviz](https://graphviz.org/) — optional, only needed for `just generate-data-model` (install with `brew install graphviz`)

## Quickstart

```sh
just bootstrap        # uv sync, copy .env, start postgres, run migrations
just createsuperuser  # create an admin user
just dev              # runserver on http://127.0.0.1:8000
```

## Common commands

```sh
just test             # pytest
just lint             # ruff check + format --check
just format           # ruff check --fix + format
just typecheck        # pyrefly
just migrate          # apply migrations
just makemigrations   # create migrations
just shell            # django shell
just up / just down   # docker compose up/down
```

## Endpoints

- `/admin/` — Django admin (themed via [django-unfold](https://unfoldadmin.com/))
- `/api/v1/schema/` — OpenAPI 3 schema
- `/api/v1/docs/` — Swagger UI
- `/api/v1/redoc/` — ReDoc

## Stack

Django 5.2 · DRF · drf-spectacular · django-unfold · Postgres 17 · pydantic-settings · WhiteNoise · gunicorn · pytest · factory-boy · ruff · pyrefly · pre-commit

## Further improvements

- [ ] Improve templating by adding copier
- [ ] Improve documentation
- [ ] Add auth (API-Key, JWT)
- [ ] Add CI + Deployment (+ Release-Please)
- [ ] Add Async Task Runner (Celery + Redis)
- [ ] Add integration example
