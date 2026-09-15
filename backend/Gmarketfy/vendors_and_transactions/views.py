import base64
import json
import logging
import re
import secrets
import string
from datetime import datetime

import requests
from django.db import transaction as db_transaction
from django.http import JsonResponse, response
from django.views.decorators.csrf import csrf_exempt
from firebase_admin import auth



from google.cloud import firestore
from google.cloud.firestore_v1.base_query import FieldFilter


from rest_framework.decorators import api_view
from rest_framework.response import Response
from django.utils import timezone
from Gmarketfy.settings import (
    CALLBACK_URL,
    DARAJA_CONSUMER_KEY as consumer_key,
    DARAJA_CONSUMER_SECRET as consumer_secret,
    DARAJA_PASSKEY as passkey,
    SHORTCODE as consumer_shortcode,
    INITIATOR_NAME as initiator_name,
    SECURITY_CREDENTIAL as security_credential,
    db as Gmarketfy_db,
)

from .models import Transactions
#from orders.services import create_ordering_history_entry

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT = 10  # seconds, for calls to Safaricom


# ---------------------------------------------------------------------------
# Daraja helpers
# ---------------------------------------------------------------------------

def get_access_token():
    """Returns an access token string, or None if the request failed."""
    url = "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials"
    try:
        response = requests.get(
            url,
            auth=(consumer_key, consumer_secret),
            timeout=REQUEST_TIMEOUT,
        )
        response.raise_for_status()
        return response.json().get("access_token")
    except (requests.RequestException, ValueError) as exc:
        logger.error("Failed to obtain Daraja access token: %s", exc)
        return None


def generate_stk_credentials():
    timestamp = timezone.now().strftime("%Y%m%d%H%M%S")
    password_string = consumer_shortcode + passkey + timestamp
    password = base64.b64encode(password_string.encode()).decode()
    return {"timestamp": timestamp, "password": password}


def create_stk_payload(amount, phone_number, callback_url, account_reference, transaction_description):
    credentials = generate_stk_credentials()
    return {
        "BusinessShortCode": consumer_shortcode,
        "Password": credentials["password"],
        "Timestamp": credentials["timestamp"],
        "TransactionType": "CustomerPayBillOnline",
        "Amount": int(amount),
        "PartyA": phone_number,
        "PartyB": consumer_shortcode,
        "PhoneNumber": phone_number,
        "CallBackURL": callback_url,
        "AccountReference": account_reference,
        "TransactionDesc": transaction_description,
    }


def build_payment_label(category, quantity, max_length):
    """
    Builds a "{category} x{quantity}" label truncated to fit Daraja's field
    limits (AccountReference: 12 chars, TransactionDesc: 13 chars) — the
    quantity suffix is always preserved; the category is trimmed to fit.
    """
    category = (category or "Item").strip()
    suffix = f" x{quantity}"

    available = max_length - len(suffix)
    if available < 1:
        # Degenerate case (huge quantity number) — just hard-truncate.
        return f"{category}{suffix}"[:max_length]

    if len(category) > available:
        category = category[:available].rstrip()

    return f"{category}{suffix}"


def send_stk_push(payload, access_token):
    url = "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }
    return requests.post(url, json=payload, headers=headers, timeout=REQUEST_TIMEOUT)


# ---------------------------------------------------------------------------
# Validation / auth helpers
# ---------------------------------------------------------------------------

def validate_phone_number(phone):
    phone = str(phone or "").strip().replace(" ", "").replace("-", "")

    if phone.startswith("+254"):
        phone = "254" + phone[4:]
    elif phone.startswith("07") or phone.startswith("01"):
        phone = "254" + phone[1:]

    if re.fullmatch(r"254(?:7|1)\d{8}", phone):
        return {"valid": True, "phone": phone}

    return {"valid": False, "phone": phone}


def generate_transaction_reference(length=10):
    characters = string.ascii_uppercase + string.digits
    while True:
        reference = "".join(secrets.choice(characters) for _ in range(length))
        if not Transactions.objects.filter(transaction_reference=reference).exists():
            return reference


def authenticate_firebase_user(request):
    auth_header = request.headers.get("Authorization")

    if not auth_header:
        return {"authenticated": False, "message": "Authorization token is required"}

    if not auth_header.startswith("Bearer "):
        return {"authenticated": False, "message": "Invalid authorization format"}

    id_token = auth_header.split("Bearer ", 1)[1]

    try:
        decoded_token = auth.verify_id_token(id_token)
        return {"authenticated": True, "user": decoded_token}
    except auth.InvalidIdTokenError:
        return {"authenticated": False, "message": "Invalid Firebase ID token"}
    except auth.ExpiredIdTokenError:
        return {"authenticated": False, "message": "Firebase ID token has expired"}
    except Exception:
        logger.exception("Unexpected error verifying Firebase token")
        return {"authenticated": False, "message": "Authentication failed"}


# ---------------------------------------------------------------------------
# payments_view — initiate an STK push
# ---------------------------------------------------------------------------

@csrf_exempt
@api_view(["POST"])
def payments_view(request, order_id):
    authentication = authenticate_firebase_user(request)
    if not authentication["authenticated"]:
        return Response({"message": authentication["message"]}, status=401)

    client_id = authentication["user"]["uid"]

    phone_validation = validate_phone_number(request.data.get("phone"))
    if not phone_validation["valid"]:
        return Response({"message": "Invalid phone number"}, status=400)
    phone_number = phone_validation["phone"]

    # --- Fetch + validate the order -------------------------------------
    doc_ref = Gmarketfy_db.collection("orders").document(order_id)
    doc = doc_ref.get()

    if not doc.exists:
        return Response({"message": "Order not found"}, status=404)

    order_data = doc.to_dict()

    if order_data.get("clientId") != client_id:
        return Response({"message": "Unauthorized: You are not the owner of this order"}, status=403)

    if order_data.get("paymentStatus") == "paid":
        return Response({"message": "This order has already been paid for"}, status=400)

    sub_total = order_data.get("subtotal")
    if not isinstance(sub_total, (int, float)) or sub_total <= 0:
        logger.error("Order %s has an invalid subtotal: %r", order_id, sub_total)
        return Response({"message": "Order is missing a valid amount"}, status=400)

    quantity = order_data.get("quantity")
    vendor_id = order_data.get("vendor_id")
    product_id = order_data.get("product_id")
    has_delivery = order_data.get("delivery", {}).get("enabled", False)
    payment_timing = order_data.get("paymentTiming", "before")

    product_doc = Gmarketfy_db.collection("products").document(product_id).get()
    if not product_doc.exists:
        logger.error("Order %s references missing product %s", order_id, product_id)
        return Response({"message": "Product for this order could not be found"}, status=400)
    category = product_doc.to_dict().get("category", "Item")

    # --- Idempotency guard: don't fire a second STK push while one is
    # already in flight for this order ------------------------------------
    with db_transaction.atomic():
        existing = (
            Transactions.objects.select_for_update()
            .filter(order_id=order_id, status="Initialized")
            .first()
        )
        if existing:
            return Response(
                {
                    "message": "A payment request for this order is already pending on your phone. "
                    "Please complete or cancel it before trying again.",
                    "transaction_reference": existing.transaction_reference,
                    "status": existing.status,
                },
                status=409,
            )

        txn = Transactions.objects.create(
            transaction_reference=generate_transaction_reference(),
            order_id=order_id,
            subtotal=sub_total,
            phone_number=phone_number,
            has_delivery=has_delivery,
            vendor_id=vendor_id,
            product_id=product_id,
            client_id=client_id,
            quantity=quantity,
            transaction_description=f"{category} x{quantity}",
            payment_timing=payment_timing,
            status="Initialized",
        )

    # --- Talk to Daraja ----------------------------------------------------
    access_token = get_access_token()
    if not access_token:
        txn.status = "Failed"
        txn.result_description = "Could not authenticate with Daraja"
        txn.save(update_fields=["status", "result_description"])
        return Response({"message": "Payment service is temporarily unavailable, please try again"}, status=502)

    payload = create_stk_payload(
        amount=sub_total,
        phone_number=phone_number,
        callback_url=CALLBACK_URL,
        account_reference=build_payment_label(category, quantity, max_length=12),
        transaction_description=build_payment_label(category, quantity, max_length=13),
    )

    try:
        response = send_stk_push(payload, access_token)
        response_data = response.json()
    except (requests.RequestException, ValueError) as exc:
        logger.error("STK push failed for order %s: %s", order_id, exc)
        txn.status = "Failed"
        txn.result_description = "Failed to reach payment provider"
        txn.save(update_fields=["status", "result_description"])
        return Response({"message": "Could not initiate payment, please try again"}, status=502)

    txn.merchant_request_id = response_data.get("MerchantRequestID")
    txn.checkout_request_id = response_data.get("CheckoutRequestID")
    # ResponseCode arrives as a string (e.g. "0") on the sync STK response —
    # result_code is an IntegerField, so cast defensively rather than let a
    # non-numeric value blow up the save() on a stricter DB backend later.
    raw_response_code = response_data.get("ResponseCode")
    try:
        txn.result_code = int(raw_response_code)
    except (TypeError, ValueError):
        txn.result_code = None
    txn.result_description = response_data.get("ResponseDescription") or response_data.get("errorMessage")

    if str(raw_response_code) == "0":
        txn.status = "Initialized"
    else:
        txn.status = "Failed"

    txn.save()

    return Response(
        {
            "message": response_data.get("CustomerMessage", "Payment request sent to your phone"),
            "transaction_reference": txn.transaction_reference,
            "status": txn.status,
        },
        status=200,
    )


# ---------------------------------------------------------------------------
# payments_callback — Daraja calls this, possibly more than once
# ---------------------------------------------------------------------------

def _extract_callback_metadata(stk_callback):
    """Turns Daraja's CallbackMetadata.Item list into a plain dict."""
    items = stk_callback.get("CallbackMetadata", {}).get("Item", [])
    return {item.get("Name"): item.get("Value") for item in items if "Name" in item}


# Statuses that already mean "this order is fully done" — payment landing
# here shouldn't rewrite anything, just confirm paymentStatus. Note "picked
# up" is deliberately NOT here: an unpaid "picked up" order paying now must
# still become "paid & picked up".
_FULLY_DONE_STATUSES = {"paid"}


def _status_after_payment(current_status):
    """
    Given the order's current `status`, returns what it should become once
    payment succeeds, following the "paid & {previous state}" scheme (e.g.
    confirmed -> "paid & confirmed", delivered -> "paid & delivered").

    Idempotent by construction: a status that's already "paid & ..." or
    already a fully-done terminal status is returned unchanged, so a
    duplicate callback (or a callback arriving after the driver app has
    already moved things along) can never double-wrap or downgrade it.
    """
    current_status = (current_status or "pending").strip()
    lowered = current_status.lower()

    if lowered.startswith("paid & ") or lowered in _FULLY_DONE_STATUSES:
        return current_status

    return f"paid & {current_status}"


@firestore.transactional
def _mark_order_paid(firestore_txn, order_ref, payment_details):
    """
    Runs inside a Firestore transaction so a duplicate/replayed callback
    can never double-apply the update or double-write the transaction
    record, and can't race another writer (e.g. the driver app flipping
    `status` at the same moment).

    `payment_details` carries the receipt-level facts that only exist on
    the Django Transactions row (id, mpesa_receipt_number,
    transaction_reference, checkout_request_id, amount) — the order doc
    itself doesn't have these. `orderingHistory` is intentionally NOT
    written here — that's driven by delivery/pickup completion, a
    different trigger than "payment succeeded".

    Returns a dict describing the order right after the update
    (client_id, driver_id, is_delivery, new_status) so the caller can
    decide whether driver/client-linkage cleanup applies — or None if
    this call was a no-op (order was already paid).
    """
    snapshot = order_ref.get(transaction=firestore_txn)
    if not snapshot.exists:
        logger.error("payments_callback: order %s not found in Firestore", order_ref.id)
        return None

    order_data = snapshot.to_dict()

    # Already applied by an earlier delivery of this same callback -> no-op,
    # covers both the status update and the transaction record below.
    if order_data.get("paymentStatus") == "paid":
        return None

    new_status = _status_after_payment(order_data.get("status"))
    paid_at = timezone.now()

    updates = {
        "paymentStatus": "paid",
        "paidAt": paid_at,
        "status": new_status,
        "mpesaReceiptNumber": payment_details["mpesa_receipt_number"],
    }
    firestore_txn.update(order_ref, updates)

    # Every successful payment gets a vendor-facing transaction record,
    # regardless of where the order is in its delivery/pickup lifecycle.
    # Doc ID = checkout_request_id (unique per Daraja payment attempt), so
    # this is idempotent at the Firestore layer too, independent of the
    # Django-side lock that should already prevent a re-run.
    vendor_txn_ref = Gmarketfy_db.collection("transactions").document(
        payment_details["checkout_request_id"]
    )
    firestore_txn.set(vendor_txn_ref, {
        "orderId": order_ref.id,
        "vendorId": order_data.get("vendor_id"),
        "clientId": order_data.get("clientId"),
        "productId": order_data.get("product_id"),
        "quantity": order_data.get("quantity"),
        "amount": payment_details["amount"],
        "currency": "KES",
        "paymentMethod": "M-Pesa",
        "mpesaReceiptNumber": payment_details["mpesa_receipt_number"],
        "transactionReference": payment_details["transaction_reference"],
        "checkoutRequestId": payment_details["checkout_request_id"],
        "djangoTransactionId": payment_details["django_transaction_id"],
        "orderStatus": new_status,
        "createdAt": paid_at,
    })

    return {
        "client_id": order_data.get("clientId"),
        "driver_id": order_data.get("driverId"),
        "is_delivery": order_data.get("delivery", {}).get("enabled", False),
        "new_status": new_status,
    }


def _apply_payment_to_order(order_id, payment_details):
    order_ref = Gmarketfy_db.collection("orders").document(order_id)
    firestore_txn = Gmarketfy_db.transaction()
    return _mark_order_paid(firestore_txn, order_ref, payment_details)


def _maybe_remove_client_from_driver(driver_id, client_id):
    """
    Backend port of the frontend's maybeRemoveClientFromDriver. Ported so
    the pay-after-delivery path — where payment itself is what makes the
    order terminal ("paid & delivered") — can trigger this cleanup too,
    not just frontend-driven status writes (which still cover pay-before
    delivery via the driver's proof-upload flow).

    Kept outside the Firestore transaction above: this is a separate
    read+conditional-write against the drivers collection, not something
    that belongs inside the order/transaction-record atomic write.
    """
    if not driver_id or not client_id:
        return
    try:
        still_active = (
            Gmarketfy_db.collection("orders")
            .where(filter=FieldFilter("driverId", "==", driver_id))
            .where(filter=FieldFilter("clientId", "==", client_id))
            .where(
                filter=FieldFilter(
                    "status",
                    "not-in",
                    ["delivered", "paid & delivered", "picked up", "cancelled"],
                )
            )
            .limit(1)
            .get()
        )
        if not still_active:
            Gmarketfy_db.collection("drivers").document(driver_id).update({
                "assignedClientIds": firestore.ArrayRemove([client_id])
            })
    except Exception:
        logger.exception(
            "Failed to check/remove client %s from driver %s", client_id, driver_id
        )


def create_ordering_history_entry(order_id):
    """
    Writes an orderingHistory doc for order_id — but only once the order
    is BOTH paid and fulfilled. Safe to call from either the payment
    callback or the fulfillment/proof-of-delivery handler; whichever
    fires second is the one that actually creates the doc. No-ops (and
    returns None) if the order isn't fully complete yet.
    """
    order_ref = Gmarketfy_db.collection("orders").document(order_id)
    order_snap = order_ref.get()
    if not order_snap.exists:
        raise ValueError(f"create_ordering_history_entry: order {order_id} not found")

    order_data = order_snap.to_dict()
    delivery_data = order_data.get("delivery", {"enabled": False})
    is_delivery = delivery_data.get("enabled", False)

    payment_done = order_data.get("paymentStatus") == "paid"
    fulfillment_done = (
        order_data.get("status") in ("proof uploaded", "delivered", "paid & delivered")
        if is_delivery
        else order_data.get("status") in ("ready", "picked up")
    )

    if not (payment_done and fulfillment_done):
        # The other half hasn't happened yet — nothing to write.
        return None

    # Guard against double-writes if both events somehow fire close together
    existing = Gmarketfy_db.collection("orderingHistory").where(
        "sourceOrderId", "==", order_id
    ).limit(1).get()
    if existing:
        return existing[0].id

    # image lives on the product doc, not the order — fetch it
    product_snap = Gmarketfy_db.collection("products").document(order_data.get("product_id")).get()
    image = product_snap.to_dict().get("image") if product_snap.exists else None

    # vendorName lives on the vendor doc, not the order — fetch it
    vendor_snap = Gmarketfy_db.collection("vendors").document(order_data.get("vendor_id")).get()
    vendor_name = vendor_snap.to_dict().get("storeName") if vendor_snap.exists else None

    final_status = "paid & delivered" if is_delivery else "picked up"

    history_ref = Gmarketfy_db.collection("orderingHistory").document()
    history_doc = {
        "id": history_ref.id,
        "sourceOrderId": order_id,
        "clientId": order_data.get("clientId"),
        "product_id": order_data.get("product_id"),
        "vendor_id": order_data.get("vendor_id"),
        "name": order_data.get("name"),
        "price": order_data.get("price"),
        "quantity": order_data.get("quantity"),
        "subtotal": order_data.get("subtotal"),
        "priceDuringPurchase": order_data.get("priceDuringPurchase", order_data.get("price")),
        "paymentTiming": order_data.get("paymentTiming"),
        "paymentStatus": "paid",
        "status": final_status,
        "placedOn": order_data.get("placedOn"),
        "createdAt": order_data.get("createdAt"),
        "completedAt": firestore.SERVER_TIMESTAMP,
        "image": image,
        "vendorName": vendor_name,
        "vendorNote": order_data.get("vendorNote"),
        "delivery": delivery_data,
        "mpesaReceiptNumber": order_data.get("mpesaReceiptNumber"),
    }

    if is_delivery:
        history_doc["driverId"] = order_data.get("driverId")

    history_ref.set(history_doc)
    return history_ref.id

@csrf_exempt
def payments_callback(request):
    # Always hand Daraja back this exact shape with a 200 — if we don't,
    # Safaricom will keep retrying the same callback for hours, and every
    # retry needs to be a safe no-op on our end (handled below).
    ack = {"ResultCode": 0, "ResultDesc": "Accepted"}

    try:
        body = json.loads(request.body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        logger.error("payments_callback: could not parse request body")
        return JsonResponse(ack, status=200)

    try:
        stk_callback = body["Body"]["stkCallback"]
        checkout_request_id = stk_callback["CheckoutRequestID"]
        merchant_request_id = stk_callback.get("MerchantRequestID")
        result_code = stk_callback.get("ResultCode")
        result_desc = stk_callback.get("ResultDesc")
    except KeyError:
        logger.error("payments_callback: unexpected payload shape: %s", body)
        return JsonResponse(ack, status=200)

    txn = None

    try:
        with db_transaction.atomic():
            txn = (
                Transactions.objects.select_for_update()
                .filter(checkout_request_id=checkout_request_id)
                .first()
            )

            if txn is None:
                logger.error(
                    "payments_callback: no transaction found for checkout_request_id=%s",
                    checkout_request_id,
                )
                return JsonResponse(ack, status=200)

            # --- The core "don't corrupt on repeat callbacks" guard -----
            # Once a transaction leaves "Initialized" it is terminal.
            # Any further callback for the same checkout_request_id is a
            # Daraja retry (or a replay) and must be a strict no-op here.
            if txn.status != "Initialized":
                logger.info(
                    "payments_callback: duplicate callback for %s (already %s), ignoring",
                    checkout_request_id,
                    txn.status,
                )
                return JsonResponse(ack, status=200)

            txn.merchant_request_id = merchant_request_id or txn.merchant_request_id
            txn.result_code = result_code
            txn.result_description = result_desc
            txn.raw_callback = body
            # timezone.now() instead of datetime.utcnow() — USE_TZ=True means
            # utcnow() produces a naive datetime that Django has to guess the
            # tz for on save. That warning in your logs was this line.
            txn.callback_processed_at = timezone.now()

            if result_code == 0:
                metadata = _extract_callback_metadata(stk_callback)
                txn.status = "Completed"
                txn.mpesa_receipt_number = metadata.get("MpesaReceiptNumber")
                txn.amount_paid = metadata.get("Amount")
                txn.transaction_date_raw = str(metadata.get("TransactionDate", ""))
            else:
                txn.status = "Failed"

            txn.save()
    except Exception:
        logger.exception("payments_callback: unhandled error updating transaction row")
        return JsonResponse(ack, status=200)

    if txn is None or txn.status != "Completed":
        return JsonResponse(ack, status=200)

    # --- Step 1: sync payment onto the Firestore order doc -------------
    # _apply_payment_to_order is expected to write paymentStatus: "paid"
    # AND mpesaReceiptNumber onto the order doc in the same update — the
    # history entry below reads the receipt number off the order doc
    # rather than taking it as a param, since it may be triggered later
    # by the fulfillment side instead of this callback.
    try:
        result = _apply_payment_to_order(
            order_id=txn.order_id,
            payment_details={
                "django_transaction_id": txn.id,
                "mpesa_receipt_number": txn.mpesa_receipt_number,
                "transaction_reference": txn.transaction_reference,
                "checkout_request_id": txn.checkout_request_id,
                # Firestore's protobuf encoder has no Decimal mapping —
                # it only knows JSON-native types (int/float/str/bool/etc).
                # txn.subtotal is a Django DecimalField, so it must be
                # cast before it's handed to any firestore_txn.set(...)
                # call downstream. This is what raised the TypeError.
                "amount": float(txn.subtotal) if txn.subtotal is not None else None,
            },
        )
        
        if result and result["is_delivery"] and result["new_status"] == "paid & delivered" and result["driver_id"]:
            try:
                _maybe_remove_client_from_driver(result["driver_id"], result["client_id"])
            except Exception:
                logger.exception(
                    "payments_callback: driver cleanup failed for order %s", txn.order_id
                )
        if not txn.firestore_synced:
            txn.firestore_synced = True
            txn.save(update_fields=["firestore_synced"])
        try:
             create_ordering_history_entry(order_id=txn.order_id)
        except Exception:
            logger.exception("payments_callback: history entry creation failed for order %s", txn.order_id)
    except Exception:
        logger.exception(
            "payments_callback: transaction %s marked Completed but Firestore order update failed",
            txn.transaction_reference,
        )
        txn.firestore_synced = False
        txn.save(update_fields=["firestore_synced"])
        return JsonResponse(ack, status=200)
    return JsonResponse(ack, status=200)
    
    
    
    import requests
import json
from django.conf import settings
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST


def _get_access_token():
    response = requests.get(
        "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
        auth=(settings.DARAJA_CONSUMER_KEY, settings.DARAJA_CONSUMER_SECRET),
    )
    response.raise_for_status()
    return response.json()["access_token"]

@csrf_exempt
def send_test_payout(request):
    """
    Hardcoded test payout: sends KSh 100 to a personal phone number
    for pulling test funds out after simulating client payments.
    """
    amount = 100
    phone_number = "254795459371"  # 0795459371 formatted to Daraja's required 2547XXXXXXXX

    access_token = _get_access_token()

    payload = {
        "InitiatorName": settings.INITIATOR_NAME,
        "SecurityCredential": settings.SECURITY_CREDENTIAL,
        "CommandID": "BusinessPayment",
        "Amount": amount,
        "PartyA": settings.SHORTCODE,
        "PartyB": phone_number,
        "Remarks": "Test payout",
        "QueueTimeOutURL": f"{settings.CALLBACK_URL}/b2c/timeout/",
        "ResultURL": f"{settings.CALLBACK_URL}/b2c/result/",
        "Occasion": "Testing",
    }

    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }

    response = requests.post(
        "https://sandbox.safaricom.co.ke/mpesa/b2c/v1/paymentrequest",  # swap to production URL when ready
        json=payload,
        headers=headers,
    )
    response.raise_for_status()
    return response.json()


@csrf_exempt
@require_POST
def b2c_result_callback(request):
    data = json.loads(request.body)
    # log it, inspect data["Result"]["ResultCode"] == 0 for success
    print(data)
    return JsonResponse({"ResultCode": 0, "ResultDesc": "Accepted"})


@csrf_exempt
@require_POST
def b2c_timeout_callback(request):
    data = json.loads(request.body)
    print(data)
    return JsonResponse({"ResultCode": 0, "ResultDesc": "Accepted"})








import logging
import requests
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST
from rest_framework.decorators import api_view
from rest_framework.response import Response

from Gmarketfy.settings import (
    CALLBACK_URL,
    INITIATOR_NAME as initiator_name,
    SECURITY_CREDENTIAL as security_credential,
    SHORTCODE as consumer_shortcode,
)


logger = logging.getLogger(__name__)

# Safaricom Production B2C Endpoint
DARAJA_B2C_URL = "https://api.safaricom.co.ke/mpesa/b2c/v1/paymentrequest"
REQUEST_TIMEOUT = 10  # Seconds


def execute_b2c_payout(amount=100, phone_number="254795459371", remarks="Test payout"):
    """
    Reusable service function to send funds from Paybill/Till (PartyA) to a phone number (PartyB).
    
    :param amount: Amount in KES (int/float)
    :param phone_number: Recipient phone number in 2547XXXXXXXX format
    :param remarks: Brief description of the payout
    :return: dict containing 'success' status, response data, or error message
    """
    access_token = get_access_token()
    if not access_token:
        logger.error("B2C Payout failed: Could not obtain Daraja access token")
        return {"success": False, "message": "Failed to obtain Daraja access token"}

    payload = {
        "InitiatorName": initiator_name,
        "SecurityCredential": security_credential,
        "CommandID": "BusinessPayment",
        "Amount": int(amount),
        "PartyA": consumer_shortcode,
        "PartyB": phone_number,
        "Remarks": remarks,
        "QueueTimeOutURL": f"{CALLBACK_URL}/api/v1/payments/b2c/timeout/",
        "ResultURL": f"{CALLBACK_URL}/api/v1/payments/b2c/result/",
        "Occasion": "Testing Reversal/Payout",
    }

    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }

    try:
        response = requests.post(
            DARAJA_B2C_URL,
            json=payload,
            headers=headers,
            timeout=REQUEST_TIMEOUT,
        )
        response_data = response.json()
        logger.info("B2C Payout triggered successfully: %s", response_data)
        return {"success": True, "data": response_data}
    except (requests.RequestException, ValueError) as exc:
        logger.error("B2C Payout request failed: %s", exc)
        return {"success": False, "message": f"Failed to connect to Daraja: {str(exc)}"}


# ---------------------------------------------------------------------------
# Views
# ---------------------------------------------------------------------------

@csrf_exempt
@api_view(["POST"])
def send_test_payout_view(request):
    """
    API View: Hardcodes KES 100 payout to +254 795 459 371 for testing.
    """
    # Hardcoded test values as requested
    TEST_AMOUNT = 100
    TEST_PHONE = "254795459371"

    result = execute_b2c_payout(
        amount=TEST_AMOUNT,
        phone_number=TEST_PHONE,
        remarks="Gmarketfy Test Reversal",
    )

    if not result["success"]:
        return Response({"message": result["message"]}, status=502)

    return Response(
        {
            "message": f"Successfully initiated KES {TEST_AMOUNT} payout to {TEST_PHONE}",
            "daraja_response": result["data"],
        },
        status=200,
    )


@csrf_exempt
@require_POST
def b2c_result_callback(request):
    """Callback receiver when Safaricom processes the B2C payout."""
    ack = {"ResultCode": 0, "ResultDesc": "Accepted"}
    try:
        data = json.loads(request.body.decode("utf-8"))
        logger.info("B2C Result Callback Received: %s", data)
    except Exception:
        logger.exception("Failed to parse B2C Result callback body")
    return JsonResponse(ack, status=200)


@csrf_exempt
@require_POST
def b2c_timeout_callback(request):
    """Callback receiver if the B2C request times out on Safaricom's side."""
    ack = {"ResultCode": 0, "ResultDesc": "Accepted"}
    try:
        data = json.loads(request.body.decode("utf-8"))
        logger.warning("B2C Timeout Callback Received: %s", data)
    except Exception:
        logger.exception("Failed to parse B2C Timeout callback body")
    return JsonResponse(ack, status=200)