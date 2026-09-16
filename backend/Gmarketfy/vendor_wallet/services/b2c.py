"""
B2C (Business to Customer) payout client for Daraja.

Isolated from the STK flow — same consumer key/secret, but different product,
different shortcode, different auth (initiator + SecurityCredential instead of
a passkey).
"""

import logging

import requests
from django.conf import settings

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT = 20


def _get_access_token():
    """Same OAuth as STK — the token is shared across products on one app."""
    url = "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials"

    # Match the environment of DARAJA_B2C_URL
    if "sandbox" not in settings.DARAJA_B2C_URL:
        url = "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials"

    try:
        res = requests.get(
            url,
            auth=(settings.DARAJA_CONSUMER_KEY, settings.DARAJA_CONSUMER_SECRET),
            timeout=REQUEST_TIMEOUT,
        )
        res.raise_for_status()
        return res.json().get("access_token")
    except (requests.RequestException, ValueError) as exc:
        logger.error("B2C: failed to get access token: %s", exc)
        return None


def execute_b2c_payout(*, amount, phone_number, remarks, occasion="Withdrawal"):
    """
    Fires a B2C payment request to Daraja.

    Returns:
      {
        "success": bool,
        "data": {...} on success — contains ConversationID, OriginatorConversationID
        "error": str on failure,
      }

    This call returns immediately after Daraja accepts the request — the
    actual success/failure arrives at B2C_RESULT_URL as a callback.
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

    # Daraja returns "ResponseCode": "0" on acceptance
    if str(data.get("ResponseCode")) == "0":
        return {"success": True, "data": data}

    return {
        "success": False,
        "error": data.get("errorMessage") or data.get("ResponseDescription") or "Daraja rejected the request",
        "data": data,
    }