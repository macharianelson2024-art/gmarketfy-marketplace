"""
B2C (Business to Customer) payout client for Daraja.

Isolated from the STK flow — same consumer key/secret, but different product,
different shortcode, different auth (initiator + SecurityCredential instead
of a passkey).
"""

import logging

import requests
from django.conf import settings

from utilities.daraja_interface.business_to_client_utils import _get_access_token

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT = 20


def execute_b2c_payout(*, amount, phone_number, remarks, occasion="Withdrawal"):
    """
    Fires a B2C payment request to Daraja.

    Returns:
      {"success": True, "data": {...}}  — Daraja accepted, callback will follow
      {"success": False, "error": str} — rejected or unreachable

    Daraja returning ResponseCode 0 only means the request was queued. The
    real outcome arrives at B2C_RESULT_URL as a callback.
    """
    access_token = _get_access_token()
    if not access_token:
        return {"success": False, "error": "Could not authenticate with Daraja"}

    payload = {
        "InitiatorName": settings.DARAJA_INITIATOR_NAME,
        "SecurityCredential": settings.DARAJA_SECURITY_CREDENTIAL,
        "CommandID": "BusinessPayment",
        "Amount": int(amount),
        "PartyA": settings.DARAJA_B2C_SHORTCODE,
        "PartyB": phone_number,
        "Remarks": remarks[:100],
        "QueueTimeOutURL": settings.B2C_TIMEOUT_URL,
        "ResultURL": settings.B2C_RESULT_URL,
        "Occasion": occasion[:100],
    }

    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }

    try:
        res = requests.post(
            settings.DARAJA_B2C_URL,
            json=payload,
            headers=headers,
            timeout=REQUEST_TIMEOUT,
        )
        data = res.json()
    except (requests.RequestException, ValueError) as exc:
        logger.error("B2C: request failed: %s", exc)
        return {"success": False, "error": str(exc)}

    if str(data.get("ResponseCode")) == "0":
        return {"success": True, "data": data}

    return {
        "success": False,
        "error": (
            data.get("errorMessage")
            or data.get("ResponseDescription")
            or "Daraja rejected the request"
        ),
        "data": data,
    }