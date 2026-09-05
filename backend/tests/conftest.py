"""Shared pytest fixtures.

Tests run against a real Postgres database -- the `revrec_test` DB created by
scripts/init-test-db.sql inside the docker-compose container. Start it first:

    docker compose up -d

`conftest.py` is auto-discovered by pytest; fixtures here are available to
every test file without importing.
"""

import os

import pytest
from dotenv import load_dotenv
from sqlalchemy import create_engine, text
from sqlalchemy.exc import OperationalError

from app import llm
from app.db import store

load_dotenv()

TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql+psycopg://revrec:revrec@localhost:5432/revrec_test",
)

# short timeout so, when Postgres is down, DB tests fail in seconds instead of
# hanging on the OS connect timeout
if TEST_DATABASE_URL.startswith("sqlite"):
    _TEST_ENGINE = create_engine(TEST_DATABASE_URL)
else:
    _TEST_ENGINE = create_engine(
        TEST_DATABASE_URL, connect_args={"connect_timeout": 3}
    )


@pytest.fixture(scope="session")
def _require_postgres():
    """Skip DB-backed tests with a clear message if Postgres isn't reachable.

    Not autouse -- the pure Pydantic-schema tests don't need a database.
    """
    try:
        with _TEST_ENGINE.connect() as conn:
            conn.execute(text("SELECT 1"))
    except OperationalError as exc:
        pytest.skip(
            f"test database unreachable at {TEST_DATABASE_URL} "
            f"-- run `docker compose up -d`  ({exc.__class__.__name__})",
            allow_module_level=False,
        )


@pytest.fixture()
def test_database_url() -> str:
    return TEST_DATABASE_URL


@pytest.fixture(autouse=True)
def _no_real_razorpay(monkeypatch):
    """Tests never create a real Razorpay Payment Link, even when a
    developer's local `.env` has real test-mode keys configured (useful for
    hand-testing the webhook listener / `/pay/:token` against a real Razorpay
    test account). Without this, every full-pipeline test run would call the
    real Payment Links API for each diagnosed event, burn Razorpay's 30-link
    test-mode quota, and leave most events non-terminal
    (`payment_link_status=AWAITING_CAPTURE`), breaking
    `test_every_event_reaches_a_terminal_status` and friends. Same isolation
    posture as `_offline_embeddings` below. Individual tests that want to
    exercise the real-Razorpay code path build their own settings object
    directly (see `tests/test_payment.py`) rather than relying on
    `get_settings()`, so they are unaffected by this.
    """
    monkeypatch.delenv("RAZORPAY_KEY_ID", raising=False)
    monkeypatch.delenv("RAZORPAY_KEY_SECRET", raising=False)
    from app.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
def _offline_embeddings(monkeypatch):
    """Never hit a real embedding model in tests.

    `app.llm.embed` is patched to raise, so the RAG layer (`app.rag`) exercises
    its honest degrade path (retrieval returns `[]`, indexing is a no-op) by
    default. RAG tests override this with a deterministic fake embedder.
    """

    def _no_embeddings(*_a, **_k):
        raise llm.LLMUnavailable("embeddings disabled in tests")

    monkeypatch.setattr("app.llm.embed", _no_embeddings)


@pytest.fixture()
def session(_require_postgres):
    """A fresh, empty store per test: drop + recreate every table, then a
    Session bound to the test database. Depends on _require_postgres, so a
    test that asks for `session` is skipped (not errored) when Postgres is down."""
    store.reset_db(TEST_DATABASE_URL)
    with store.get_session(TEST_DATABASE_URL) as sess:
        yield sess
