import json
import logging
from decimal import Decimal, InvalidOperation

from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from rest_framework.decorators import api_view
from rest_framework.response import Response

from .auth import authenticate_firebase_user
from .models import Withdrawal
from .services import (
    create_withdrawal,
    get_payout_destination,
    get_payout_destination_history,
    get_vendor_balance,
    handle_b2c_result,
    set_payout_destination,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Vault summary
# ---------------------------------------------------------------------------

@csrf_exempt
@api_view(["GET"])
def vault_summary_view(request):
    auth = authenticate_firebase_user(request)
    if not auth["authenticated"]:
        return Response({"message": auth["message"]}, status=401)

    vendor_id = auth["user"]["uid"]
    b = get_vendor_balance(vendor_id)

    return Response(
        {
            "balance": f"{b['balance']:.2f}",
            "pendingBalance": f"{b['pendingBalance']:.2f}",
        },
        status=200,
    )


# ---------------------------------------------------------------------------
# Payout destination
# ---------------------------------------------------------------------------

def _serialize_destination(dest):
    if dest is None:
        return None
    return {
        "type": dest.type,
        "number": dest.number,
        "accountNumber": dest.account_number,
        "phone": dest.phone,
        "updatedAt": dest.updated_at,
    }


@csrf_exempt
@api_view(["GET", "POST"])
def payout_destination_view(request):
    auth = authenticate_firebase_user(request)
    if not auth["authenticated"]:
        return Response({"message": auth["message"]}, status=401)
    vendor_id = auth["user"]["uid"]

    if request.method == "GET":
        dest = get_payout_destination(vendor_id)
        return Response({"destination": _serialize_destination(dest)}, status=200)

    # POST
    dest, err = set_payout_destination(
        vendor_id,
        request.data.get("type"),
        request.data.get("number"),
        request.data.get("accountNumber"),
        request.data.get("phone"),
    )
    if err:
        return Response({"message": err}, status=400)

    return Response(
        {
            "message": "Payout destination updated.",
            "destination": _serialize_destination(dest),
        },
        status=200,
    )


@csrf_exempt
@api_view(["GET"])
def payout_destination_history_view(request):
    auth = authenticate_firebase_user(request)
    if not auth["authenticated"]:
        return Response({"message": auth["message"]}, status=401)
    vendor_id = auth["user"]["uid"]

    changes = get_payout_destination_history(vendor_id)

    return Response(
        {
            "changes": [
                {
                    "old": (
                        {
                            "type": c.old_type,
                            "number": c.old_number,
                            "accountNumber": c.old_account_number,
                            "phone": c.old_phone,
                        }
                        if c.old_type else None
                    ),
                    "new": {
                        "type": c.new_type,
                        "number": c.new_number,
                        "accountNumber": c.new_account_number,
                        "phone": c.new_phone,
                    },
                    "changedAt": c.changed_at,
                }
                for c in changes
            ]
        },
        status=200,
    )


# ---------------------------------------------------------------------------
# Withdrawals
# ---------------------------------------------------------------------------

def _serialize_withdrawal(w):
    return {
        "id": w.id,
        "status": w.status,
        "amount": f"{w.amount:.2f}",
        "fee": f"{w.fee:.2f}",
        "net_amount": f"{w.net_amount:.2f}",
        "phone": w.phone,
        "destination_type": w.destination_type,
        "destination_number": w.destination_number,
        "mpesa_receipt_number": w.mpesa_receipt_number,
        "result_description": w.result_description,
        "requested_at": w.requested_at,
        "completed_at": w.completed_at,
    }


@csrf_exempt
@api_view(["POST"])
def withdraw_view(request):
    auth = authenticate_firebase_user(request)
    if not auth["authenticated"]:
        return Response({"message": auth["message"]}, status=401)
    vendor_id = auth["user"]["uid"]

    try:
        amount = Decimal(str(request.data.get("amount", "")))
    except (InvalidOperation, TypeError):
        return Response({"message": "Invalid amount."}, status=400)

    if amount <= 0:
        return Response({"message": "Amount must be positive."}, status=400)

    w, err = create_withdrawal(vendor_id, amount)
    if err:
        return Response({"message": err}, status=400)

    return Response(
        {
            "withdrawal_id": w.id,
            "status": w.status,
            "amount": f"{w.amount:.2f}",
            "fee": f"{w.fee:.2f}",
            "net_amount": f"{w.net_amount:.2f}",
            "message": (
                f"Withdrawal initiated. You'll receive KSh {w.net_amount:.2f} shortly."
                if w.status == Withdrawal.STATUS_PROCESSING
                else (w.result_description or "Withdrawal failed.")
            ),
        },
        status=200,
    )


@csrf_exempt
@api_view(["GET"])
def withdrawals_list_view(request):
    auth = authenticate_firebase_user(request)
    if not auth["authenticated"]:
        return Response({"message": auth["message"]}, status=401)
    vendor_id = auth["user"]["uid"]

    rows = Withdrawal.objects.filter(vendor_id=vendor_id)[:50]
    return Response({"withdrawals": [_serialize_withdrawal(w) for w in rows]}, status=200)


@csrf_exempt
@api_view(["GET"])
def withdrawal_status_view(request, withdrawal_id):
    auth = authenticate_firebase_user(request)
    if not auth["authenticated"]:
        return Response({"message": auth["message"]}, status=401)
    vendor_id = auth["user"]["uid"]

    w = Withdrawal.objects.filter(pk=withdrawal_id, vendor_id=vendor_id).first()
    if not w:
        return Response({"message": "Not found"}, status=404)

    return Response(_serialize_withdrawal(w), status=200)


# ---------------------------------------------------------------------------
# B2C callbacks (Daraja — no Firebase auth)
# ---------------------------------------------------------------------------

@csrf_exempt
def b2c_result_callback(request):
    ack = {"ResultCode": 0, "ResultDesc": "Accepted"}

    try:
        body = json.loads(request.body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        logger.error("b2c_result_callback: bad body")
        return JsonResponse(ack, status=200)

    originator_id = (body.get("Result") or {}).get("OriginatorConversationID")
    if not originator_id:
        logger.error("b2c_result_callback: no OriginatorConversationID: %s", body)
        return JsonResponse(ack, status=200)

    try:
        handle_b2c_result(originator_id, body)
    except Exception:
        logger.exception("b2c_result_callback: unhandled error")

    return JsonResponse(ack, status=200)


@csrf_exempt
def b2c_timeout_callback(request):
    ack = {"ResultCode": 0, "ResultDesc": "Accepted"}

    try:
        body = json.loads(request.body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return JsonResponse(ack, status=200)

    logger.warning("b2c_timeout_callback: %s", body)
    # We don't reverse on timeout — B2C might still complete and send the
    # real ResultURL. Only the ResultURL moves the withdrawal to terminal.
    return JsonResponse(ack, status=200)