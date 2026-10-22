from fastapi.testclient import TestClient

from roughcut_engine.app import app

client = TestClient(app)


def test_health():
    body = client.get("/health").json()
    assert body["ok"] is True and body["version"]


def test_silences_route(tone_with_gap):
    r = client.post("/silences", json={"path": str(tone_with_gap)})
    assert r.status_code == 200
    assert len(r.json()["silences"]) == 2


def test_missing_file_is_400():
    r = client.post("/silences", json={"path": "/nope.wav"})
    assert r.status_code == 400
    assert "File not found" in r.json()["detail"]
    assert client.post("/transcribe", json={"path": "/nope.wav"}).status_code == 400


def test_cors_allows_local_dev_server_only():
    ok = client.get("/health", headers={"Origin": "http://localhost:3000"})
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:3000"
    bad = client.get("/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in bad.headers
