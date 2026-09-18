import base64
import json
import logging
import re
import secrets
import string

import requests
from django.db import transaction as db_transaction
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from firebase_admin import auth
from vendor_wallet.services import credit_order_payment

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
    db as Gmarketfy_db,
    DARAJA_OAUTH_URL,
    DARAJA_STK_URL,
)

from .models import Transactions

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT = 10


# ---------------------------------------------------------------------------
# Daraja helpers
# ---------------------------------------------------------------------------

def get_access_token():
    """Returns an access token string, or None if the request failed."""
    try:
        response = requests.get(
            DARAJA_OAUTH_URL,
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
        return f"{category}{suffix}"[:max_length]

    if len(category) > available:
        category = category[:available].rstrip()

    return f"{category}{suffix}"


def send_stk_push(payload, access_token):
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }
    return requests.post(DARAJA_STK_URL, json=payload, headers=headers, timeout=REQUEST_TIMEOUT)


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

    raw_response_code = response_data.get("ResponseCode")
    try:
        txn.result_code = int(raw_response_code)
    except (TypeError, ValueError):
        txn.result_code = None
    txn.result_description = response_data.get("ResponseDescription") or response_data.get("errorMessage")

    txn.status = "Initialized" if str(raw_response_code) == "0" else "Failed"
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


_FULLY_DONE_STATUSES = {"paid"}


def _status_after_payment(current_status):
    """
    Given the order's current `status`, returns what it should become once
    payment succeeds, following the "paid & {previous state}" scheme.

    Idempotent by construction: a status that's already "paid & ..." or
    already a fully-done terminal status is returned unchanged.
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
    record, and can't race another writer.
    """
    snapshot = order_ref.get(transaction=firestore_txn)
    if not snapshot.exists:
        logger.error("payments_callback: order %s not found in Firestore", order_ref.id)
        return None

    order_data = snapshot.to_dict()

    if order_data.get("paymentStatus") == "paid":
        return None

    new_status = _status_after_payment(order_data.get("status"))
    paid_at = timezone.now()

    firestore_txn.update(order_ref, {
        "paymentStatus": "paid",
        "paidAt": paid_at,
        "status": new_status,
        "mpesaReceiptNumber": payment_details["mpesa_receipt_number"],
    })

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
    Backend port of the frontend's maybeRemoveClientFromDriver. Kept outside
    the Firestore transaction — this is a separate read+conditional-write
    against the drivers collection.
    """
    if not driver_id or not client_id:
        return
    try:
        still_active = (
            Gmarketfy_db.collection("orders")
            .where(filter=FieldFilter("driverId", "==", driver_id))
            .where(filter=FieldFilter("clientId", "==", client_id))
            .where(filter=FieldFilter(
                "status", "not-in",
                ["delivered", "paid & delivered", "picked up", "cancelled"],
            ))
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
    callback or the fulfillment handler; whichever fires second is the
    one that actually creates the doc.
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
        return None

    existing = Gmarketfy_db.collection("orderingHistory").where(
        "sourceOrderId", "==", order_id
    ).limit(1).get()
    if existing:
        return existing[0].id

    product_snap = Gmarketfy_db.collection("products").document(order_data.get("product_id")).get()
    image = product_snap.to_dict().get("image") if product_snap.exists else None

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

            # Once a transaction leaves "Initialized" it is terminal. Any
            # further callback for the same checkout_request_id is a Daraja
            # retry (or a replay) and must be a strict no-op here.
            if txn.status != "Initialized":
                logger.info(
                    "payments_callback: duplicate callback for %s (already %s), ignoring",
                    checkout_request_id, txn.status,
                )
                return JsonResponse(ack, status=200)

            txn.merchant_request_id = merchant_request_id or txn.merchant_request_id
            txn.result_code = result_code
            txn.result_description = result_desc
            txn.raw_callback = body
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

    # --- Credit the vendor's wallet -------------------------------------
    # Idempotent — safe to call multiple times for the same txn. Outside the
    # transaction block above so a wallet failure doesn't roll back the
    # Completed status.
    try:
        credit_order_payment(txn)
    except Exception:
        logger.exception(
            "payments_callback: wallet credit failed for txn %s",
            txn.transaction_reference,
        )

    # --- Sync payment onto the Firestore order doc ----------------------
    try:
        result = _apply_payment_to_order(
            order_id=txn.order_id,
            payment_details={
                "django_transaction_id": txn.id,
                "mpesa_receipt_number": txn.mpesa_receipt_number,
                "transaction_reference": txn.transaction_reference,
                "checkout_request_id": txn.checkout_request_id,
                # Firestore's protobuf encoder has no Decimal mapping —
                # cast before handing to firestore_txn.set(...).
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
            logger.exception(
                "payments_callback: history entry creation failed for order %s", txn.order_id
            )
    except Exception:
        logger.exception(
            "payments_callback: transaction %s marked Completed but Firestore order update failed",
            txn.transaction_reference,
        )
        txn.firestore_synced = False
        txn.save(update_fields=["firestore_synced"])
        return JsonResponse(ack, status=200)

    return JsonResponse(ack, status=200)


# ---------------------------------------------------------------------------
# payment_status_view — poll a specific order payment
# ---------------------------------------------------------------------------

@csrf_exempt
@api_view(["GET"])
def payment_status_view(request, transaction_reference):
    """
    Returns the current state of a single order payment. Used by the client
    to poll after initiating an STK push.

    Only returns payments belonging to the authenticated client, so a random
    reference can't be used to spy on someone else's payment.
    """
    authentication = authenticate_firebase_user(request)
    if not authentication["authenticated"]:
        return Response({"message": authentication["message"]}, status=401)

    client_id = authentication["user"]["uid"]

    txn = (
        Transactions.objects
        .filter(transaction_reference=transaction_reference, client_id=client_id)
        .first()
    )
    if txn is None:
        return Response({"message": "Payment not found"}, status=404)

    return Response(
        {
            "transaction_reference": txn.transaction_reference,
            "order_id": txn.order_id,
            "status": txn.status,
            "mpesa_receipt_number": txn.mpesa_receipt_number,
            "result_description": txn.result_description,
            "subtotal": str(txn.subtotal) if txn.subtotal is not None else None,
            "created_at": txn.created_at,
        },
        status=200,
    )