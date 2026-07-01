from __future__ import annotations

import base64
import json
import os
import fcntl
import secrets
import time
import socket
import ipaddress
import uuid
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_DOWN
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import httpx
from pydantic import BaseModel, Field, HttpUrl
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives import hashes, serialization


USDC_BASE = Decimal("1000000")
MAX_PAYMENT_HEADER_BYTES = 64 * 1024
ARC_TESTNET = {
    "chain": "arcTestnet",
    "network": "eip155:5042002",
    "chain_id": 5042002,
    "domain": 26,
    "gateway_wallet": "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    "usdc": "0x3600000000000000000000000000000000000000",
    "gateway_api": "https://gateway-api-testnet.circle.com/v1",
}


class X402Error(RuntimeError):
    pass


class X402ConfigError(X402Error):
    pass


class X402PolicyError(X402Error):
    pass


class X402PaymentError(X402Error):
    pass


class PayResourceInput(BaseModel):
    url: HttpUrl
    label: Optional[str] = None
    max_usdc: Optional[str] = Field(default=None, pattern=r"^\d+(\.\d{1,6})?$")
    metadata: Optional[Dict[str, str | int | float | bool | None]] = None


class PayBatchInput(BaseModel):
    urls: List[HttpUrl] = Field(min_length=1, max_length=50)
    max_usdc_per_resource: Optional[str] = Field(default=None, pattern=r"^\d+(\.\d{1,6})?$")
    concurrency: int = Field(default=4, ge=1, le=16)


class DepositInput(BaseModel):
    amount_usdc: str = Field(pattern=r"^\d+(\.\d{1,6})?$")
    approve_amount_usdc: Optional[str] = Field(default=None, pattern=r"^\d+(\.\d{1,6})?$")
    skip_approval: bool = False
    assume_approval_confirmed: bool = False
    idempotency_prefix: Optional[str] = None

_PRIVATE_IPV4_NETWORKS = tuple(ipaddress.ip_network(net) for net in (
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/4",
    "240.0.0.0/4",
))


def _host_to_ip(host: str) -> ipaddress._BaseAddress | None:
    try:
        return ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return None


def _is_private_ip_address(ip: ipaddress._BaseAddress) -> bool:
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        return _is_private_ip_address(mapped)
    if isinstance(ip, ipaddress.IPv4Address):
        if any(ip in network for network in _PRIVATE_IPV4_NETWORKS):
            return True
    return bool(
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def _is_private_host_literal(host: str) -> bool:
    ip = _host_to_ip(host)
    return _is_private_ip_address(ip) if ip is not None else False


def _resolves_to_private_host(host: str) -> bool:
    if _host_to_ip(host) is not None:
        return _is_private_host_literal(host)
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise X402PolicyError(f"Unable to resolve payment host: {host}") from exc
    ips = {item[4][0] for item in infos if item and item[4]}
    return any(_is_private_host_literal(ip) for ip in ips)


def _normalize_usdc(value: str | int | float | Decimal) -> str:
    raw = str(value).strip()
    try:
        dec = Decimal(raw)
    except InvalidOperation as exc:
        raise X402PolicyError(f"Invalid USDC amount: {raw}") from exc
    if dec < 0:
        raise X402PolicyError(f"Invalid negative USDC amount: {raw}")
    quantized = dec.quantize(Decimal("0.000001"), rounding=ROUND_DOWN)
    if quantized != dec:
        raise X402PolicyError(f"USDC amount has more than 6 decimals: {raw}")
    txt = format(quantized, "f")
    if "." in txt:
        txt = txt.rstrip("0").rstrip(".")
    return txt or "0"


def _usdc_to_base_units(value: str | int | float | Decimal) -> int:
    return int((Decimal(_normalize_usdc(value)) * USDC_BASE).to_integral_exact())


def _base_units_to_usdc(value: str | int) -> str:
    units = int(str(value))
    if units < 0:
        raise X402PolicyError(f"Invalid negative USDC base units: {units}")
    whole, frac = divmod(units, 1_000_000)
    if frac == 0:
        return str(whole)
    return f"{whole}.{frac:06d}".rstrip("0")


def _redact_error(exc: BaseException) -> str:
    text = str(exc)
    text = text.replace(os.environ.get("CIRCLE_API_KEY", "__NO_MATCH__"), "[redacted]")
    text = text.replace(os.environ.get("CIRCLE_ENTITY_SECRET", "__NO_MATCH__"), "[redacted]")
    return text


def _b64_json(data: Any) -> str:
    return base64.b64encode(json.dumps(data, separators=(",", ":")).encode()).decode()


def _decode_b64_json(value: str) -> Dict[str, Any]:
    if len(value.encode()) > MAX_PAYMENT_HEADER_BYTES:
        raise X402PaymentError(f"PAYMENT-REQUIRED header exceeds {MAX_PAYMENT_HEADER_BYTES} bytes")
    try:
        return json.loads(base64.b64decode(value).decode())
    except Exception as exc:
        raise X402PaymentError("Invalid PAYMENT-REQUIRED header") from exc


def _normalize_evm_signature(signature: Any) -> str:
    value = str(signature).strip()
    hex_chars = "0123456789abcdefABCDEF"
    if value.startswith("0x") and len(value) == 132 and all(c in hex_chars for c in value[2:]):
        return value
    if len(value) == 130 and all(c in hex_chars for c in value):
        return "0x" + value
    try:
        raw = base64.b64decode(value, validate=True)
        if len(raw) == 65:
            return "0x" + raw.hex()
    except Exception:
        pass
    raise X402PaymentError("Circle DCW returned an unsupported EVM signature encoding")


def _is_localhost(host: str) -> bool:
    h = host.lower().strip("[]")
    return h in {"localhost", "127.0.0.1", "::1"}


@dataclass
class X402Policy:
    daily_budget_usdc: str = "10"
    max_single_payment_usdc: str = "1"
    max_batch_payment_usdc: str = "5"
    host_allowlist: List[str] = None  # type: ignore[assignment]
    require_https: bool = True
    allow_localhost: bool = False

    def __post_init__(self) -> None:
        if self.host_allowlist is None:
            self.host_allowlist = ["*"]
        self.daily_budget_usdc = _normalize_usdc(self.daily_budget_usdc)
        self.max_single_payment_usdc = _normalize_usdc(self.max_single_payment_usdc)
        self.max_batch_payment_usdc = _normalize_usdc(self.max_batch_payment_usdc)

    def validate_url(self, url: str) -> str:
        parsed = urlparse(url)
        if parsed.username or parsed.password:
            raise X402PolicyError("URL credentials are not allowed")
        if not parsed.hostname:
            raise X402PolicyError("URL host is required")
        if self.require_https and parsed.scheme != "https":
            if not (self.allow_localhost and parsed.scheme == "http" and _is_localhost(parsed.hostname)):
                raise X402PolicyError("Payment URL must use HTTPS")
        is_local = _is_localhost(parsed.hostname)
        if is_local and not self.allow_localhost:
            raise X402PolicyError("Localhost payment URLs are disabled")
        if _is_private_host_literal(parsed.hostname) and not (self.allow_localhost and is_local):
            raise X402PolicyError("Private/local payment hosts are blocked by policy")
        if not (self.allow_localhost and is_local) and _resolves_to_private_host(parsed.hostname):
            raise X402PolicyError("Payment host resolves to private/local address and is blocked by policy")
        if "*" not in self.host_allowlist:
            h = parsed.hostname.lower()
            ok = False
            for rule in self.host_allowlist:
                r = rule.strip().lower()
                if r == h:
                    ok = True
                elif r.startswith("*.") and h.endswith(r[1:]) and len(h) > len(r) - 1:
                    ok = True
            if not ok:
                raise X402PolicyError(f"Host {parsed.hostname} not in allowlist")
        return parsed.hostname

    def validate_amount(self, amount_usdc: str, cap: Optional[str] = None) -> str:
        amount = _normalize_usdc(amount_usdc)
        if Decimal(amount) > Decimal(self.max_single_payment_usdc):
            raise X402PolicyError(f"Payment {amount} exceeds single cap {self.max_single_payment_usdc} USDC")
        if cap and Decimal(amount) > Decimal(_normalize_usdc(cap)):
            raise X402PolicyError(f"Seller price {amount} exceeds caller cap {cap} USDC")
        return amount

    def validate_batch_total(self, amounts: List[str]) -> str:
        total = sum(Decimal(_normalize_usdc(x)) for x in amounts)
        total_s = _normalize_usdc(total)
        if total > Decimal(self.max_batch_payment_usdc):
            raise X402PolicyError(f"Batch total {total_s} exceeds batch cap {self.max_batch_payment_usdc} USDC")
        return total_s


class JsonFileLedger:
    ACTIVE_STATUSES = {"reserved", "success"}

    def __init__(self, path: str = ".x402-python-ledger.json") -> None:
        self.path = Path(path)

    def _load_unlocked(self) -> Dict[str, Any]:
        if not self.path.exists():
            return {"payments": []}
        return json.loads(self.path.read_text())

    def _save_unlocked(self, data: Dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(json.dumps(data, indent=2))
        tmp.replace(self.path)

    def _with_lock(self, fn: Any, *, write: bool = True) -> Any:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        lock_path = self.path.with_suffix(self.path.suffix + ".lock")
        with lock_path.open("a+") as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
            try:
                data = self._load_unlocked()
                result = fn(data)
                if write:
                    self._save_unlocked(data)
                return result
            finally:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

    def _active_spend(self, data: Dict[str, Any], wallet: str) -> Decimal:
        today = time.strftime("%Y-%m-%d", time.gmtime())
        total = Decimal("0")
        for row in data.get("payments", []):
            if (
                row.get("wallet", "").lower() == wallet.lower()
                and row.get("created_at", "")[:10] == today
                and row.get("status") in self.ACTIVE_STATUSES
            ):
                total += Decimal(str(row.get("amount_usdc", "0")))
        return total

    def _upsert(self, data: Dict[str, Any], record: Dict[str, Any]) -> None:
        payments = data.setdefault("payments", [])
        for idx, row in enumerate(payments):
            if row.get("id") == record["id"]:
                payments[idx] = {**row, **record}
                return
        payments.append(record)

    def daily_spend(self, wallet: str) -> str:
        return self._with_lock(lambda data: _normalize_usdc(self._active_spend(data, wallet)), write=False)

    def reserve_payment(self, payment_id: str, wallet: str, url: str, amount_usdc: str, daily_budget_usdc: str) -> None:
        amount = _normalize_usdc(amount_usdc)

        def op(data: Dict[str, Any]) -> None:
            active = self._active_spend(data, wallet)
            if active + Decimal(amount) > Decimal(_normalize_usdc(daily_budget_usdc)):
                raise X402PolicyError(f"Daily budget exceeded: spent_or_reserved={_normalize_usdc(active)}, planned={amount}, limit={daily_budget_usdc}")
            self._upsert(data, {
                "id": payment_id,
                "wallet": wallet,
                "url": url,
                "amount_usdc": amount,
                "status": "reserved",
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            })

        self._with_lock(op)

    def record_payment(self, payment_id: str, wallet: str, url: str, amount_usdc: str, status: str) -> None:
        if status not in {"success", "failed"}:
            raise X402PolicyError(f"Unsupported ledger status: {status}")
        amount = _normalize_usdc(amount_usdc)

        def op(data: Dict[str, Any]) -> None:
            self._upsert(data, {
                "id": payment_id,
                "wallet": wallet,
                "url": url,
                "amount_usdc": amount,
                "status": status,
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            })

        self._with_lock(op)

    def record_success(self, wallet: str, url: str, amount_usdc: str) -> None:
        self.record_payment(f"pay_{uuid.uuid4()}", wallet, url, amount_usdc, "success")


class CircleDcwNative:
    def __init__(
        self,
        *,
        api_key: str,
        wallet_id: str,
        wallet_address: str,
        entity_secret: str = "",
        blockchain: str = "ARC-TESTNET",
        api_base: str = "https://api.circle.com",
    ) -> None:
        if not api_key:
            raise X402ConfigError("CIRCLE_API_KEY is required")
        if not wallet_id:
            raise X402ConfigError("CIRCLE_DCW_WALLET_ID is required")
        if not wallet_address:
            raise X402ConfigError("CIRCLE_DCW_WALLET_ADDRESS is required")
        if not entity_secret:
            raise X402ConfigError("CIRCLE_ENTITY_SECRET is required for native Python DCW signing. It is encrypted into a fresh entitySecretCiphertext per request.")
        self.api_key = api_key
        self.wallet_id = wallet_id
        self.wallet_address = wallet_address
        self.entity_secret = entity_secret
        self.blockchain = blockchain
        self.api_base = api_base.rstrip("/")
        self._entity_public_key: str | None = None

    def _headers(self) -> Dict[str, str]:
        return {"authorization": f"Bearer {self.api_key}", "content-type": "application/json"}

    def _get_entity_public_key(self) -> str:
        if self._entity_public_key:
            return self._entity_public_key
        with httpx.Client(timeout=30.0) as client:
            response = client.get(f"{self.api_base}/v1/w3s/config/entity/publicKey", headers={"authorization": f"Bearer {self.api_key}"})
        data = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
        if response.status_code >= 400:
            raise X402PaymentError(f"Circle entity public key fetch failed: {response.status_code} {data.get('message') or data.get('error') or response.text[:160]}")
        public_key = data.get("data", {}).get("publicKey") or data.get("publicKey")
        if not public_key:
            raise X402PaymentError("Circle entity public key response missing publicKey")
        self._entity_public_key = str(public_key)
        return self._entity_public_key

    def _fresh_entity_secret_ciphertext(self) -> str:
        secret = self.entity_secret.strip()
        if not secret:
            raise X402ConfigError("CIRCLE_ENTITY_SECRET is required to generate a fresh entitySecretCiphertext")
        if not all(c in "0123456789abcdefABCDEF" for c in secret) or len(secret) != 64:
            raise X402ConfigError("CIRCLE_ENTITY_SECRET must be a 64-character hex-encoded 32-byte secret")
        public_key_value = self._get_entity_public_key().strip()
        key_bytes: bytes
        if "BEGIN PUBLIC KEY" in public_key_value:
            key_bytes = public_key_value.encode()
            public_key = serialization.load_pem_public_key(key_bytes)
        else:
            try:
                key_bytes = base64.b64decode(public_key_value)
                public_key = serialization.load_der_public_key(key_bytes)
            except Exception:
                pem = "-----BEGIN PUBLIC KEY-----\n" + public_key_value + "\n-----END PUBLIC KEY-----\n"
                public_key = serialization.load_pem_public_key(pem.encode())
        encrypted = public_key.encrypt(
            bytes.fromhex(secret),
            padding.OAEP(
                mgf=padding.MGF1(algorithm=hashes.SHA256()),
                algorithm=hashes.SHA256(),
                label=None,
            ),
        )
        return base64.b64encode(encrypted).decode()

    def sign_typed_data(self, typed_data: Dict[str, Any]) -> str:
        payload = {
            "walletId": self.wallet_id,
            "walletAddress": self.wallet_address,
            "blockchain": self.blockchain,
            "data": json.dumps(typed_data, separators=(",", ":")),
            "entitySecretCiphertext": self._fresh_entity_secret_ciphertext(),
            "memo": "x402 Gateway authorization",
        }
        with httpx.Client(timeout=60.0) as client:
            response = client.post(f"{self.api_base}/v1/w3s/developer/sign/typedData", headers={**self._headers(), "X-Request-Id": str(uuid.uuid4())}, json=payload)
        data = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
        if response.status_code >= 400:
            raise X402PaymentError(f"Circle DCW signTypedData failed: {response.status_code} {data.get('message') or data.get('error') or response.text[:160]}")
        signature = data.get("data", {}).get("signature")
        if not signature:
            raise X402PaymentError("Circle DCW signTypedData response missing signature")
        return _normalize_evm_signature(signature)

    def create_contract_execution(self, *, contract_address: str, abi_function_signature: str, abi_parameters: List[str], idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        payload = {
            "idempotencyKey": idempotency_key or secrets.token_hex(16),
            "walletId": self.wallet_id,
            "contractAddress": contract_address,
            "abiFunctionSignature": abi_function_signature,
            "abiParameters": abi_parameters,
            "fee": {"type": "level", "config": {"feeLevel": "MEDIUM"}},
            "entitySecretCiphertext": self._fresh_entity_secret_ciphertext(),
        }
        with httpx.Client(timeout=60.0) as client:
            response = client.post(f"{self.api_base}/v1/w3s/developer/transactions/contractExecution", headers={**self._headers(), "X-Request-Id": str(uuid.uuid4())}, json=payload)
        data = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
        if response.status_code >= 400:
            raise X402PaymentError(f"Circle DCW contract execution failed: {response.status_code} {data.get('message') or data.get('error') or response.text[:160]}")
        return data


class X402ArcClient:
    """Native Python x402 buyer client. Native only. No raw buyer private key.

    The client calls Circle Developer-Controlled Wallet signTypedData directly with
    CIRCLE_ENTITY_SECRET, encrypts a fresh entitySecretCiphertext per request, builds the x402 Payment-Signature header, and
    retries the seller request.
    """

    def __init__(self, dcw: CircleDcwNative, *, chain: Dict[str, Any] = ARC_TESTNET, policy: Optional[X402Policy] = None, ledger: Optional[JsonFileLedger] = None) -> None:
        self.dcw = dcw
        self.chain = chain
        self.policy = policy or X402Policy()
        self.ledger = ledger or JsonFileLedger(os.environ.get("X402_LEDGER_PATH", ".x402-python-ledger.json"))

    @classmethod
    def from_env(cls) -> "X402ArcClient":
        allow_localhost = os.environ.get("X402_ALLOW_LOCALHOST", "false").lower() == "true"
        allowlist = [x.strip() for x in os.environ.get("X402_HOST_ALLOWLIST", "*").split(",") if x.strip()]
        policy = X402Policy(
            daily_budget_usdc=os.environ.get("X402_DAILY_BUDGET_USDC", "10"),
            max_single_payment_usdc=os.environ.get("X402_MAX_SINGLE_PAYMENT_USDC", "1"),
            max_batch_payment_usdc=os.environ.get("X402_MAX_BATCH_PAYMENT_USDC", "5"),
            host_allowlist=allowlist,
            allow_localhost=allow_localhost,
        )
        dcw = CircleDcwNative(
            api_key=os.environ.get("CIRCLE_API_KEY", ""),
            wallet_id=os.environ.get("CIRCLE_DCW_WALLET_ID", ""),
            wallet_address=os.environ.get("CIRCLE_DCW_WALLET_ADDRESS", ""),
            entity_secret=os.environ.get("CIRCLE_ENTITY_SECRET", ""),
            blockchain=os.environ.get("CIRCLE_DCW_BLOCKCHAIN", "ARC-TESTNET"),
            api_base=os.environ.get("CIRCLE_API_BASE", "https://api.circle.com"),
        )
        return cls(dcw, policy=policy)

    def _select_requirement(self, payment_required: Dict[str, Any]) -> Dict[str, Any]:
        accepts = payment_required.get("accepts")
        if not isinstance(accepts, list):
            raise X402PaymentError("PAYMENT-REQUIRED missing accepts[]")
        for opt in accepts:
            extra = opt.get("extra") if isinstance(opt, dict) else None
            if (
                isinstance(opt, dict)
                and opt.get("network") == self.chain["network"]
                and isinstance(extra, dict)
                and extra.get("name") == "GatewayWalletBatched"
                and extra.get("version") == "1"
                and isinstance(extra.get("verifyingContract"), str)
            ):
                return opt
        raise X402PaymentError(f"No GatewayWalletBatched option for {self.chain['network']}")

    def _fetch_402(self, url: str, *, method: str = "GET", headers: Optional[Dict[str, str]] = None, body: Any = None) -> tuple[httpx.Response, Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
        with httpx.Client(timeout=60.0, follow_redirects=False) as client:
            response = client.request(method, url, headers=headers, content=body)
        if response.status_code != 402:
            return response, None, None
        header = response.headers.get("PAYMENT-REQUIRED") or response.headers.get("Payment-Required")
        if not header:
            raise X402PaymentError("402 response missing PAYMENT-REQUIRED header")
        payment_required = _decode_b64_json(header)
        requirement = self._select_requirement(payment_required)
        return response, payment_required, requirement

    def supports(self, url: str) -> Dict[str, Any]:
        try:
            host = self.policy.validate_url(url)
            response, payment_required, requirement = self._fetch_402(url)
            if response.status_code != 402 or requirement is None:
                return {"supported": False, "url": url, "host": host, "error": "Resource does not require payment"}
            amount = _base_units_to_usdc(requirement["amount"])
            return {"supported": True, "url": url, "host": host, "amountUsdc": amount, "rawRequirements": requirement}
        except Exception as exc:
            return {"supported": False, "url": url, "host": "", "error": _redact_error(exc)}

    def gateway_balance(self) -> Dict[str, Any]:
        payload = {"token": "USDC", "sources": [{"depositor": self.dcw.wallet_address, "domain": self.chain["domain"]}]}
        with httpx.Client(timeout=30.0) as client:
            response = client.post(f"{self.chain['gateway_api']}/balances", headers={"content-type": "application/json"}, json=payload)
        data = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
        if response.status_code >= 400:
            raise X402PaymentError(f"Gateway balance failed: {response.status_code} {data}")
        return {"ok": True, "gateway": data}

    def _check_budget(self, amount_usdc: str) -> None:
        spent = Decimal(self.ledger.daily_spend(self.dcw.wallet_address))
        if spent + Decimal(amount_usdc) > Decimal(self.policy.daily_budget_usdc):
            raise X402PolicyError(f"Daily budget exceeded: spent={spent}, planned={amount_usdc}, limit={self.policy.daily_budget_usdc}")

    def _typed_data(self, requirement: Dict[str, Any]) -> tuple[Dict[str, Any], Dict[str, str]]:
        amount_base = str(requirement["amount"])
        now = int(time.time())
        message = {
            "from": self.dcw.wallet_address,
            "to": requirement["payTo"],
            "value": amount_base,
            "validAfter": "0",
            "validBefore": str(now + 604900),
            "nonce": "0x" + secrets.token_hex(32),
        }
        typed_data = {
            "types": {
                "EIP712Domain": [
                    {"name": "name", "type": "string"},
                    {"name": "version", "type": "string"},
                    {"name": "chainId", "type": "uint256"},
                    {"name": "verifyingContract", "type": "address"},
                ],
                "TransferWithAuthorization": [
                    {"name": "from", "type": "address"},
                    {"name": "to", "type": "address"},
                    {"name": "value", "type": "uint256"},
                    {"name": "validAfter", "type": "uint256"},
                    {"name": "validBefore", "type": "uint256"},
                    {"name": "nonce", "type": "bytes32"},
                ],
            },
            "domain": {
                "name": "GatewayWalletBatched",
                "version": "1",
                "chainId": self.chain["chain_id"],
                "verifyingContract": requirement["extra"]["verifyingContract"],
            },
            "primaryType": "TransferWithAuthorization",
            "message": message,
        }
        return typed_data, message

    def _build_payment_signature(self, payment_required: Dict[str, Any], requirement: Dict[str, Any]) -> str:
        typed_data, auth = self._typed_data(requirement)
        signature = self.dcw.sign_typed_data(typed_data)
        payload = {
            "x402Version": payment_required.get("x402Version", 2),
            "payload": {"authorization": auth, "signature": signature},
            "resource": payment_required.get("resource"),
            "accepted": requirement,
        }
        return _b64_json(payload)

    def pay_resource(self, url: str, label: Optional[str] = None, max_usdc: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        payment_id = f"pay_{uuid.uuid4()}"
        url_s = url
        host = ""
        amount_usdc = "0"
        reserved = False
        try:
            parsed = PayResourceInput(url=url, label=label, max_usdc=max_usdc, metadata=metadata)
            url_s = str(parsed.url)
            host = self.policy.validate_url(url_s)
            probe_response, payment_required, requirement = self._fetch_402(url_s)
            if probe_response.status_code != 402 or requirement is None or payment_required is None:
                return {"id": payment_id, "status": "success", "url": url_s, "host": host, "amountUsdc": "0", "httpStatus": probe_response.status_code, "data": _json_or_text(probe_response)}
            amount_usdc = self.policy.validate_amount(_base_units_to_usdc(requirement["amount"]), parsed.max_usdc)
            self.ledger.reserve_payment(payment_id, self.dcw.wallet_address, url_s, amount_usdc, self.policy.daily_budget_usdc)
            reserved = True
            payment_signature = self._build_payment_signature(payment_required, requirement)
            with httpx.Client(timeout=60.0, follow_redirects=False) as client:
                response = client.get(url_s, headers={"Payment-Signature": payment_signature})
            if response.status_code >= 400:
                self.ledger.record_payment(payment_id, self.dcw.wallet_address, url_s, amount_usdc, "failed")
                reserved = False
                return {"id": payment_id, "status": "failed", "url": url_s, "host": host, "amountUsdc": amount_usdc, "httpStatus": response.status_code, "error": _safe_body(response), "label": label}
            self.ledger.record_payment(payment_id, self.dcw.wallet_address, url_s, amount_usdc, "success")
            reserved = False
            return {"id": payment_id, "status": "success", "url": url_s, "host": host, "amountUsdc": amount_usdc, "httpStatus": response.status_code, "data": _json_or_text(response), "label": label, "metadata": metadata}
        except Exception as exc:
            if reserved:
                try:
                    self.ledger.record_payment(payment_id, self.dcw.wallet_address, url_s, amount_usdc, "failed")
                except Exception:
                    pass
            return {"id": payment_id, "status": "rejected", "url": url_s, "host": host, "amountUsdc": amount_usdc, "error": _redact_error(exc), "label": label}


    def pay_batch(self, urls: List[str], max_usdc_per_resource: Optional[str] = None, concurrency: int = 4) -> Dict[str, Any]:
        parsed = PayBatchInput(urls=urls, max_usdc_per_resource=max_usdc_per_resource, concurrency=concurrency)
        normalized_urls = [str(u) for u in parsed.urls]
        probes = [self.supports(url) for url in normalized_urls]
        if any(not p.get("supported") for p in probes):
            return {"status": "rejected", "plannedTotalUsdc": "0", "paidTotalUsdc": "0", "receipts": [], "error": "batch preflight failed", "probes": probes}
        amounts = []
        try:
            for p in probes:
                amounts.append(self.policy.validate_amount(str(p["amountUsdc"]), parsed.max_usdc_per_resource))
            planned = self.policy.validate_batch_total(amounts)
            self._check_budget(planned)
        except Exception as exc:
            return {"status": "rejected", "plannedTotalUsdc": "0", "paidTotalUsdc": "0", "receipts": [], "error": _redact_error(exc), "probes": probes}
        receipts = [self.pay_resource(url, max_usdc=amount) for url, amount in zip(normalized_urls, amounts)]
        paid = sum(Decimal(r.get("amountUsdc", "0")) for r in receipts if r.get("status") == "success")
        status = "success" if all(r.get("status") == "success" for r in receipts) else "partial"
        return {"status": status, "plannedTotalUsdc": planned, "paidTotalUsdc": _normalize_usdc(paid), "receipts": receipts}

    def gateway_deposit(self, amount_usdc: str, approve_amount_usdc: Optional[str] = None, skip_approval: bool = False, assume_approval_confirmed: bool = False, idempotency_prefix: Optional[str] = None) -> Dict[str, Any]:
        parsed = DepositInput(amount_usdc=amount_usdc, approve_amount_usdc=approve_amount_usdc, skip_approval=skip_approval, assume_approval_confirmed=assume_approval_confirmed, idempotency_prefix=idempotency_prefix)
        amount = _normalize_usdc(parsed.amount_usdc)
        approve_amount = _normalize_usdc(parsed.approve_amount_usdc or amount)
        if not parsed.skip_approval and not parsed.assume_approval_confirmed and Decimal(approve_amount) < Decimal(amount):
            raise X402PolicyError(f"Approval amount {approve_amount} USDC is below deposit amount {amount} USDC")
        prefix = parsed.idempotency_prefix or secrets.token_hex(8)
        if not parsed.skip_approval and not parsed.assume_approval_confirmed:
            result = self.dcw.create_contract_execution(
                contract_address=self.chain["usdc"],
                abi_function_signature="approve(address,uint256)",
                abi_parameters=[self.chain["gateway_wallet"], str(_usdc_to_base_units(approve_amount))],
                idempotency_key=f"{prefix}-approve",
            )
            return {"amountUsdc": amount, "nextAction": "wait_for_approval_confirmation", "approval": result}
        result = self.dcw.create_contract_execution(
            contract_address=self.chain["gateway_wallet"],
            abi_function_signature="depositFor(address,address,uint256)",
            abi_parameters=[self.chain["usdc"], self.dcw.wallet_address, str(_usdc_to_base_units(amount))],
            idempotency_key=f"{prefix}-deposit",
        )
        return {"amountUsdc": amount, "nextAction": "track_deposit_confirmation", "deposit": result}

    def custom_tools(self) -> Dict[str, Any]:
        return {
            "x402_pay_resource": lambda **kwargs: self.pay_resource(**kwargs),
            "x402_pay_batch": lambda **kwargs: self.pay_batch(**kwargs),
            "x402_gateway_balance": lambda: self.gateway_balance(),
            "x402_gateway_deposit": lambda **kwargs: self.gateway_deposit(**kwargs),
            "x402_supports": lambda url: self.supports(url),
        }

    def langchain_tools(self) -> list[Any]:
        from .adapters.langchain import get_langchain_tools
        return get_langchain_tools(self)

    def crewai_tools(self) -> list[Any]:
        from .adapters.crewai import get_crewai_tools
        return get_crewai_tools(self)


def _json_or_text(response: httpx.Response) -> Any:
    ctype = response.headers.get("content-type", "")
    if "application/json" in ctype:
        try:
            return response.json()
        except Exception:
            return None
    return response.text[:500]


def _safe_body(response: httpx.Response) -> str:
    try:
        data = response.json()
        text = json.dumps(data)
    except Exception:
        text = response.text
    return text[:500].replace("Payment-Signature", "Payment-Signature[redacted]")
