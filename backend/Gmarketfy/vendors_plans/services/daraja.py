import base64
import logging
import re

import requests
from django.conf import settings
from django.utils import timezone

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT = 10

# Same credentials as the order-payments app. Whatever is in .env right now
# (sandbox or production) applies here too — no branching in code.
_SHORTCODE       = settings.SHORTCODE
_PASSKEY         = settings.DARAJA_PASSKEY
_CONSUMER_KEY    = settings.DARAJA_CONSUMER_KEY
_CONSUMER_SECRET = settings.DARAJA_CONSUMER_SECRET
_CALLBACK_URL    = settings.PLAN_PAYMENT_CALLBACK_URL

# Match the URL environment to the credentials. Since .env is sandbox right
# now, these point at sandbox. Flip both when you go live.
DARAJA_OAUTH_URL = "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials"
DARAJA_STK_URL   = "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest"


def plans_callback_url():
    return f"{_CALLBACK_URL}/api/vendors/plans/callback/"


def get_access_token():
    try:
        response = requests.get(
            DARAJA_OAUTH_URL,
            auth=(_CONSUMER_KEY, _CONSUMER_SECRET),
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
        return response.json().get("access_token")
    except (requests.RequestException, ValueError) as exc:
        logger.error("Daraja access token request failed: %s", exc)
        return None


def _generate_stk_credentials():
    timestamp = timezone.now().strftime("%Y%m%d%H%M%S")
    password_string = _SHORTCODE + _PASSKEY + timestamp
    password = base64.b64encode(password_string.encode()).decode()
    return {"timestamp": timestamp, "password": password}


def create_stk_payload(amount, phone_number, account_reference, transaction_description):
    credentials = _generate_stk_credentials()
    return {
        "BusinessShortCode": _SHORTCODE,
        "Password": credentials["password"],
        "Timestamp": credentials["timestamp"],
        "TransactionType": "CustomerPayBillOnline",
        "Amount": int(amount),
        "PartyA": phone_number,
        "PartyB": _SHORTCODE,
        "PhoneNumber": phone_number,
        "CallBackURL": plans_callback_url(),
        "AccountReference": account_reference[:12],
        "TransactionDesc": transaction_description[:13],
    }


def send_stk_push(payload, access_token):
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }
    return requests.post(DARAJA_STK_URL, json=payload, headers=headers, timeout=REQUEST_TIMEOUT)


def validate_phone_number(phone):
    phone = str(phone or "").strip().replace(" ", "").replace("-", "")
    if phone.startswith("+254"):
        phone = "254" + phone[4:]
    elif phone.startswith("07") or phone.startswith("01"):
        phone = "254" + phone[1:]
    if re.fullmatch(r"254(?:7|1)\d{8}", phone):
        return {"valid": True, "phone": phone}
    return {"valid": False, "phone": phone}