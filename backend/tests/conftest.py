from collections.abc import Generator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.config import settings
from app.core.security import hash_password
from app.db import get_db
from app.main import app
from app.models import Base, User

# The suite runs with the default secret, which startup otherwise refuses.
settings.allow_insecure_secret = True

TEST_USER_EMAIL = "engineer@fsdp.test"
TEST_USER_PASSWORD = "fsdp-test-password"

# Hash once per test session; bcrypt is intentionally slow.
_TEST_PASSWORD_HASH = hash_password(TEST_USER_PASSWORD)


@pytest.fixture
def session_factory() -> Generator[sessionmaker[Session], None, None]:
    """Session factory of the in-memory test database (for rows the API no longer writes)."""
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        future=True,
    )

    # Enforce foreign keys so SQLite behaves like PostgreSQL in tests.
    @event.listens_for(engine, "connect")
    def _enable_sqlite_fks(dbapi_connection, _connection_record) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    Base.metadata.create_all(engine)
    try:
        yield sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    finally:
        Base.metadata.drop_all(engine)


@pytest.fixture
def client(session_factory: sessionmaker[Session]) -> Generator[TestClient, None, None]:
    """Authenticated (admin) API client backed by an in-memory database."""
    with session_factory() as db:
        db.add(
            User(
                email=TEST_USER_EMAIL,
                name="Test Engineer",
                password_hash=_TEST_PASSWORD_HASH,
                role="admin",
            )
        )
        db.commit()

    def override_get_db() -> Generator[Session, None, None]:
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    try:
        test_client = TestClient(app)
        login = test_client.post(
            "/auth/login", json={"email": TEST_USER_EMAIL, "password": TEST_USER_PASSWORD}
        )
        assert login.status_code == 200, login.text
        yield test_client
    finally:
        app.dependency_overrides.clear()
