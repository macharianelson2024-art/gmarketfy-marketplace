import json
import logging
import secrets
import string
from datetime import timedelta

import requests
from django.db import IntegrityError
from django.db import transaction as db_transaction
from django.http import JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from rest_framework.decorators import api_view
from rest_framework.response import Response

from .auth import authenticate_firebase_user
from .models import Plan, PlanPayment, VendorSubscription
from .serializers import (
    PlanPaymentSerializer,
    PlanSerializer,
    UpgradePlanRequestSerializer,
    VendorSubscriptionSerializer,
    PlanPaymentStatusSerializer
)
from .services.daraja import (
    create_stk_payload,
    get_access_token,
    send_stk_push,
    validate_phone_number,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _generate_transaction_reference(length=10):
    alphabet = string.ascii_uppercase + string.digits
    while True:
        ref = "".join(secrets.choice(alphabet) for _ in range(length))
        if not PlanPayment.objects.filter(transaction_reference=ref).exists():
            return ref


def _extract_callback_metadata(stk_callback):
    items = stk_callback.get("CallbackMetadata", {}).get("Item", [])
    return {item.get("Name"): item.get("Value") for item in items if "Name" in item}


def _classify_change(current_plan, new_plan):
    if current_plan is None:
        # First paid plan ever (Basic is implicit — no sub row for it).
        return PlanPayment.CHANGE_NEW if new_plan.tier > 0 else PlanPayment.CHANGE_RENEW
    if new_plan.tier == current_plan.tier:
        return PlanPayment.CHANGE_RENEW
    if new_plan.tier > current_plan.tier:
        return PlanPayment.CHANGE_UPGRADE
    return PlanPayment.CHANGE_DOWNGRADE


def _activate_subscription(payment):
    """Called inside the callback's atomic block on a successful payment."""
    now = timezone.now()

    # Cancel any existing active subscription for this vendor.
    VendorSubscription.objects.filter(
        vendor_id=payment.vendor_id,
        status=VendorSubscription.STATUS_ACTIVE,
    ).update(status=VendorSubscription.STATUS_CANCELLED, updated_at=now)

    VendorSubscription.objects.create(
        vendor_id=payment.vendor_id,
        plan=payment.plan,
        started_at=now,
        expires_at=now + timedelta(days=payment.plan.duration_days),
        status=VendorSubscription.STATUS_ACTIVE,
    )


# ---------------------------------------------------------------------------
# GET /api/vendors/plans/
# ---------------------------------------------------------------------------

@csrf_exempt
@api_view(["GET"])
def list_plans_view(request):
    auth = authenticate_firebase_user(request)
    if not auth["authenticated"]:
        return Response({"message": auth["message"]}, status=401)

    plans = Plan.objects.filter(is_active=True)
    return Response({"plans": PlanSerializer(plans, many=True).data}, status=200)


# ---------------------------------------------------------------------------
# GET /api/vendors/plans/current/
# ---------------------------------------------------------------------------

@csrf_exempt
@api_view(["GET"])
def current_plan_view(request):
    auth = authenticate_firebase_user(request)
    if not auth["authenticated"]:
        return Response({"message": auth["message"]}, status=401)
    vendor_id = auth["user"]["uid"]

    now = timezone.now()

    # Cheap hygiene: flip any just-expired active sub to "expired" in one query.
    VendorSubscription.objects.filter(
        vendor_id=vendor_id,
        status=VendorSubscription.STATUS_ACTIVE,
        expires_at__lt=now,
    ).update(status=VendorSubscription.STATUS_EXPIRED, updated_at=now)

    sub = (
        VendorSubscription.objects
        .select_related("plan")
        .filter(vendor_id=vendor_id, status=VendorSubscription.STATUS_ACTIVE)
        .first()
    )

    if sub is None:
        # No active sub → vendor is on Basic (the implicit free tier).
        basic = Plan.objects.filter(tier=0, is_active=True).order_by("display_order").first()
        return Response(
            {
                "plan": PlanSerializer(basic).data if basic else None,
                "subscription": None,
                "is_default": True,
            },
            status=200,
        )

    return Response(
        {
            "plan": PlanSerializer(sub.plan).data,
            "subscription": VendorSubscriptionSerializer(sub).data,
            "is_default": False,
        },
        status=200,
    )


# ---------------------------------------------------------------------------
# GET /api/vendors/plans/history/
# ---------------------------------------------------------------------------

@csrf_exempt
@api_view(["GET"])
def payment_history_view(request):
    auth = authenticate_firebase_user(request)
    if not auth["authenticated"]:
        return Response({"message": auth["message"]}, status=401)
    vendor_id = auth["user"]["uid"]

    payments = (
        PlanPayment.objects
        .select_related("plan")
        .filter(vendor_id=vendor_id)
        .order_by("-created_at")[:100]
    )
    return Response({"payments": PlanPaymentSerializer(payments, many=True).data}, status=200)


# ---------------------------------------------------------------------------
# POST /api/vendors/plans/upgrade/   (upgrade | downgrade | renew | first buy)
# ---------------------------------------------------------------------------

@csrf_exempt
@api_view(["POST"])
def upgrade_plan_view(request):
    auth = authenticate_firebase_user(request)
    if not auth["authenticated"]:
        return Response({"message": auth["message"]}, status=401)
    vendor_id = auth["user"]["uid"]

    serializer = UpgradePlanRequestSerializer(data=request.data)
    if not serializer.is_valid():
        return Response(serializer.errors, status=400)
    plan_id = serializer.validated_data["plan_id"]
    raw_phone = serializer.validated_data.get("phone") or ""

    try:
        plan = Plan.objects.get(pk=plan_id, is_active=True)
    except Plan.DoesNotExist:
        return Response({"message": "Plan not found or inactive"}, status=404)

    try:
        with db_transaction.atomic():
            current_sub = (
                VendorSubscription.objects
                .select_for_update()
                .filter(vendor_id=vendor_id, status=VendorSubscription.STATUS_ACTIVE)
                .select_related("plan")
                .first()
            )
            current_plan = current_sub.plan if current_sub else None

            change_type = _classify_change(current_plan, plan)

            # ---- Free plan path (downgrade to Basic, or already on Basic) ----
            if plan.price == 0:
                if current_sub:
                    current_sub.status = VendorSubscription.STATUS_CANCELLED
                    current_sub.updated_at = timezone.now()
                    current_sub.save(update_fields=["status", "updated_at"])

                return Response(
                    {
                        "message": f"Switched to {plan.name} plan.",
                        "change_type": change_type,
                        "plan": PlanSerializer(plan).data,
                        "payment_required": False,
                    },
                    status=200,
                )

            # ---- Paid plan path ---------------------------------------------
            # Idempotency pre-check (nice error message).
            pending = (
                PlanPayment.objects
                .filter(vendor_id=vendor_id, status=PlanPayment.STATUS_INITIALIZED)
                .first()
            )
            if pending:
                return Response(
                    {
                        "message": "You have a payment already pending on your phone. "
                                   "Complete or cancel it before starting another.",
                        "transaction_reference": pending.transaction_reference,
                        "status": pending.status,
                    },
                    status=409,
                )

            # Resolve phone: request body first, no vendor-doc fallback (Django
            # doesn't know the vendor's phone — Firebase owns that).
            phone_validation = validate_phone_number(raw_phone)
            if not phone_validation["valid"]:
                return Response(
                    {"message": "A valid phone number is required to pay for this plan."},
                    status=400,
                )
            phone_number = phone_validation["phone"]

            payment = PlanPayment.objects.create(
                transaction_reference=_generate_transaction_reference(),
                vendor_id=vendor_id,
                plan=plan,
                previous_subscription=current_sub,
                change_type=change_type,
                amount=plan.price,
                phone_number=phone_number,
                status=PlanPayment.STATUS_INITIALIZED,
            )

    except IntegrityError:
        # Lost a race against a parallel request — the partial unique index
        # on (vendor_id, status="Initialized") caught it.
        return Response(
            {"message": "Another payment request is already in progress for this account."},
            status=409,
        )

    # ---- Talk to Daraja (outside the transaction) -------------------------
    access_token = get_access_token()
    if not access_token:
        payment.status = PlanPayment.STATUS_FAILED
        payment.result_description = "Could not authenticate with Daraja"
        payment.save(update_fields=["status", "result_description", "updated_at"])
        return Response({"message": "Payment service is temporarily unavailable."}, status=502)

    payload = create_stk_payload(
        amount=plan.price,
        phone_number=phone_number,
        account_reference=f"PLAN {plan.name.upper()}",
        transaction_description=f"{plan.name} plan",
    )

    try:
        print("sending the callback : " , payload)
        response = send_stk_push(payload, access_token)
        response_data = response.json()
    except (requests.RequestException, ValueError) as exc:
        logger.error("STK push failed for vendor %s plan %s: %s", vendor_id, plan.id, exc)
        payment.status = PlanPayment.STATUS_FAILED
        payment.result_description = "Failed to reach payment provider"
        payment.save(update_fields=["status", "result_description", "updated_at"])
        return Response({"message": "Could not initiate payment, please try again."}, status=502)

    payment.merchant_request_id = response_data.get("MerchantRequestID")
    payment.checkout_request_id = response_data.get("CheckoutRequestID")
    raw_code = response_data.get("ResponseCode")
    try:
        payment.result_code = int(raw_code)
    except (TypeError, ValueError):
        payment.result_code = None
    payment.result_description = (
        response_data.get("ResponseDescription") or response_data.get("errorMessage")
    )
    payment.status = (
        PlanPayment.STATUS_INITIALIZED if str(raw_code) == "0" else PlanPayment.STATUS_FAILED
    )
    payment.save()

    return Response(
        {
            "message": response_data.get("CustomerMessage", "Payment request sent to your phone."),
            "transaction_reference": payment.transaction_reference,
            "checkout_request_id": payment.checkout_request_id,
            "status": payment.status,
            "change_type": payment.change_type,
        },
        status=200,
    )


# ---------------------------------------------------------------------------
# POST /api/vendors/plans/callback/  (Daraja → us, no Firebase auth)
# ---------------------------------------------------------------------------

@csrf_exempt
def plans_callback(request):
    # Always ack with this exact shape, no matter what. Safaricom retries hard.
    ack = {"ResultCode": 0, "ResultDesc": "Accepted"}

    try:
        body = json.loads(request.body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        logger.error("plans_callback: could not parse request body")
        return JsonResponse(ack, status=200)

    try:
        stk = body["Body"]["stkCallback"]
        checkout_request_id = stk["CheckoutRequestID"]
        merchant_request_id = stk.get("MerchantRequestID")
        result_code = stk.get("ResultCode")
        result_desc = stk.get("ResultDesc")
    except KeyError:
        logger.error("plans_callback: unexpected payload shape: %s", body)
        return JsonResponse(ack, status=200)

    try:
        with db_transaction.atomic():
            payment = (
                PlanPayment.objects
                .select_for_update()
                .filter(checkout_request_id=checkout_request_id)
                .select_related("plan")
                .first()
            )

            if payment is None:
                logger.error(
                    "plans_callback: no PlanPayment for checkout_request_id=%s",
                    checkout_request_id,
                )
                return JsonResponse(ack, status=200)

            # Terminal-once: any further callback for the same id is a retry.
            if payment.status != PlanPayment.STATUS_INITIALIZED:
                logger.info(
                    "plans_callback: duplicate callback for %s (already %s)",
                    checkout_request_id, payment.status,
                )
                return JsonResponse(ack, status=200)

            payment.merchant_request_id = merchant_request_id or payment.merchant_request_id
            payment.result_code = result_code
            payment.result_description = result_desc
            payment.raw_callback = body
            payment.callback_processed_at = timezone.now()

            if result_code == 0:
                metadata = _extract_callback_metadata(stk)
                payment.status = PlanPayment.STATUS_COMPLETED
                payment.mpesa_receipt_number = metadata.get("MpesaReceiptNumber")
            else:
                payment.status = PlanPayment.STATUS_FAILED

            payment.save()

            if payment.status == PlanPayment.STATUS_COMPLETED:
                _activate_subscription(payment)
    except Exception:
        logger.exception("plans_callback: unhandled error")
        return JsonResponse(ack, status=200)

    return JsonResponse(ack, status=200)



@csrf_exempt
@api_view(["GET"])
def payment_status_view(request, transaction_reference):
    """Single payment status — used by the frontend to poll after STK push."""
    auth = authenticate_firebase_user(request)
    if not auth["authenticated"]:
        return Response({"message": auth["message"]}, status=401)
    vendor_id = auth["user"]["uid"]

    payment = (
        PlanPayment.objects
        .select_related("plan")
        .filter(transaction_reference=transaction_reference, vendor_id=vendor_id)
        .first()
    )
    if payment is None:
        return Response({"message": "Payment not found"}, status=404)

    return Response(PlanPaymentStatusSerializer(payment).data, status=200)