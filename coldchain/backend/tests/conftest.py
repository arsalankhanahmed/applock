import os
import tempfile

_db = os.path.join(tempfile.mkdtemp(prefix="coldchain-test-"), "test.db")
os.environ.update({
    "DATABASE_URL": f"sqlite:///{_db}",
    "RUN_BACKGROUND_LOOP": "false",
    "ADMIN_EMAIL": "admin@test.local",
    "ADMIN_PASSWORD": "secret-pass-1",
    "WHATSAPP_PROVIDER": "log",
    "SMS_PROVIDER": "log",
    "SMTP_HOST": "",
    "OFFLINE_AFTER_MINUTES": "5",
    "ESCALATION_MINUTES": "15",
    "REMINDER_MINUTES": "30",
    "TICK_TOKEN": "tick-secret",
})

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.database import Base, engine  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture()
def client():
    Base.metadata.drop_all(engine)
    with TestClient(app) as c:                      # runs start-up: creates tables and the first admin
        token = c.post("/api/auth/login", json={"email": "admin@test.local", "password": "secret-pass-1"}
                       ).json()["token"]
        c.headers["Authorization"] = f"Bearer {token}"
        yield c


@pytest.fixture()
def device(client):
    site = client.post("/api/sites", json={"name": "Karachi Warehouse"}).json()
    dev = client.post("/api/devices", json={"site_id": site["id"], "name": "Cold Room 1",
                                            "interval_seconds": 60}).json()
    return {"site": site, **dev, "headers": {"X-Device-Serial": dev["serial"], "X-Device-Key": dev["secret"]}}
