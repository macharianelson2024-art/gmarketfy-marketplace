

import logging


from django.contrib.sites import requests

from django.conf import settings

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT = settings.REQUEST_TIMEOUT


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
