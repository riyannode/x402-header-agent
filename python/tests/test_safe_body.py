"""Tests for _safe_body redaction."""
from x402_arc_sdk.client import _safe_body


class _FakeResponse:
    """Minimal response stub for redaction tests."""

    def __init__(self, text: str):
        self._text = text

    def json(self):
        raise Exception("no json")

    @property
    def text(self):
        return self._text


def test_safe_body_redacts_reflected_payment_signature():
    r = _FakeResponse(
        "Payment-Signature: eyJ4NDAyVmVyc2lvbiI6MiwicGF5bG9hZCI6eyJzaWduYXR1cmUiOiIweDEyMzQifX0="
    )
    out = _safe_body(r)
    assert "eyJ4NDAy" not in out
    assert "[redacted]" in out


def test_safe_body_redacts_x_payment_header():
    r = _FakeResponse(
        "x-payment: eyJ4NDAyVmVyc2lvbiI6MiwicGF5bG9hZCI6eyJzaWduYXR1cmUiOiIweDEyMzQifX0="
    )
    out = _safe_body(r)
    assert "eyJ4NDAy" not in out
    assert "[redacted]" in out


def test_safe_body_redacts_json_value():
    r = _FakeResponse('{"Payment-Signature": "eyJ4NDAyVmVyc2lvbiI6MiwicGF5bG9hZCI6eyJzaWduYXR1cmUiOiIweDEyMzQifX0="}')
    out = _safe_body(r)
    assert "eyJ4NDAy" not in out
    assert "[redacted]" in out


def test_safe_body_redacts_jwt():
    r = _FakeResponse("token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U")
    out = _safe_body(r)
    assert "eyJhbGci" not in out
    assert "[redacted-jwt]" in out
