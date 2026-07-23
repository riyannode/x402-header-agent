from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from x402_arc_sdk import PaymentInfo, SellerAgent

app = FastAPI()
seller = SellerAgent.from_env()


@app.get("/premium-data")
async def premium_data(request: Request):
    result = await seller.process_request(
        request.headers.get("Payment-Signature"),
        str(request.url),
        "$0.001",
    )

    if isinstance(result, dict):
        return JSONResponse(
            content=result["body"],
            status_code=result["status"],
            headers=result.get("headers", {}),
        )

    payment: PaymentInfo = result
    return JSONResponse(
        content={
            "ok": True,
            "paidBy": payment.payer,
            "amountUsdc": payment.amount,
            "transaction": payment.transaction,
            "content": "paid payload",
        },
        headers=payment.response_headers,
    )


@app.on_event("shutdown")
async def close_seller() -> None:
    await seller.aclose()
