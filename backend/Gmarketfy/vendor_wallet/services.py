"""
Vendor wallet services — balance, payout destination, withdrawals.

Single source of truth for money math. All DB writes that affect balance
go through this module so the ledger stays consistent.
"""

import logging
import re
from decimal import Decimal

from django.conf import settings
from django.db import IntegrityError, transaction as db_transaction
from django.db.models import Q, Sum
from django.utils import timezone

from .models import (
    PayoutDestinationChange,
    VendorPayoutDestination,
    WalletLedgerEntry,
    Withdrawal,
)
from .services_b2c import execute_b2c_payout

from decimal import Decimal, ROUND_HALF_UP


logger = logging.getLogger(__name__)


_PHONE_RE  = re.compile(r"^254\d{9}$")
_LABEL_RE  = re.compile(r"^[\w\-. /#@+,:()&']{1,50}$", re.UNICODE)


# ---------------------------------------------------------------------------
# Balance
# ---------------------------------------------------------------------------

def get_vendor_balance(vendor_id):
    """
    Returns { balance, pendingBalance }.

    balance = all credits - all debits, all time.
    pendingBalance will reflect in-flight withdrawals once we distinguish
    them; currently always 0.
    """
    agg = WalletLedgerEntry.objects.filter(vendor_id=vendor_id).aggregate(
        credits=Sum("amount", filter=Q(kind=WalletLedgerEntry.KIND_CREDIT)),
        debits=Sum("amount",  filter=Q(kind=WalletLedgerEntry.KIND_DEBIT)),
    )

    credits = agg["credits"] or Decimal("0")
    debits  = agg["debits"]  or Decimal("0")

    return {
        "balance": credits - debits,
        "pendingBalance": Decimal("0"),
    }


# ---------------------------------------------------------------------------
# Order-payment credit
# ---------------------------------------------------------------------------

def credit_order_payment(txn):
    """
    Idempotent credit for a completed order payment.
    """
    if not txn.vendor_id or txn.subtotal is None:
        logger.warning(
            "credit_order_payment: txn %s missing vendor_id or subtotal, skipping",
            getattr(txn, "transaction_reference", "?"),
        )
        return None

    try:
        entry, created = WalletLedgerEntry.objects.get_or_create(
            vendor_id=txn.vendor_id,
            kind=WalletLedgerEntry.KIND_CREDIT,
            source_type=WalletLedgerEntry.SOURCE_ORDER_PAYMENT,
            source_id=txn.transaction_reference,
            defaults={
                "amount": txn.subtotal,
                "description": f"Order {txn.order_id}",
            },
        )
    except IntegrityError:
        return None

    if created:
        logger.info(
            "wallet credited: vendor=%s amount=%s ref=%s",
            txn.vendor_id, txn.subtotal, txn.transaction_reference,
        )
    return entry if created else None


# ---------------------------------------------------------------------------
# Payout destination — phone + optional label, B2C only
# ---------------------------------------------------------------------------

def _normalize_phone(raw):
    p = str(raw or "").strip().replace(" ", "").replace("-", "")
    if p.startswith("+254"):
        p = "254" + p[4:]
    elif p.startswith("07") or p.startswith("01"):
        p = "254" + p[1:]
    return p


def validate_payout_destination(phone, label=None):
    """
    Returns (cleaned_dict, error_message_or_None).
    """
    phone_clean = _normalize_phone(phone) if phone else None
    label_clean = (label or "").strip() or "My M-Pesa"

    if not phone_clean:
        return None, "Phone number is required."

    if not _PHONE_RE.match(phone_clean):
        return None, "Phone must be a valid Kenyan M-Pesa number (e.g. 07XX XXX XXX)."

    if not _LABEL_RE.match(label_clean):
        return None, "Label contains invalid characters or is too long."

    return {
        "phone": phone_clean,
        "label": label_clean,
    }, None


def get_payout_destination(vendor_id):
    return VendorPayoutDestination.objects.filter(vendor_id=vendor_id).first()


@db_transaction.atomic
def set_payout_destination(vendor_id, phone, label=None):
    """
    Upserts the destination + writes an audit row. No-op if unchanged.
    """
    cleaned, err = validate_payout_destination(phone, label)
    if err:
        return None, err

    existing = VendorPayoutDestination.objects.select_for_update().filter(
        vendor_id=vendor_id
    ).first()

    if existing:
        unchanged = (
            existing.phone == cleaned["phone"]
            and (existing.label or "") == cleaned["label"]
        )
        if unchanged:
            return existing, None

        PayoutDestinationChange.objects.create(
            vendor_id=vendor_id,
            old_phone=existing.phone,
            old_label=existing.label,
            new_phone=cleaned["phone"],
            new_label=cleaned["label"],
        )

        existing.phone = cleaned["phone"]
        existing.label = cleaned["label"]
        existing.save(update_fields=["phone", "label", "updated_at"])
        return existing, None

    dest = VendorPayoutDestination.objects.create(vendor_id=vendor_id, **cleaned)
    PayoutDestinationChange.objects.create(
        vendor_id=vendor_id,
        old_phone=None,
        old_label=None,
        new_phone=cleaned["phone"],
        new_label=cleaned["label"],
    )
    return dest, None


def get_payout_destination_history(vendor_id, limit=50):
    return PayoutDestinationChange.objects.filter(vendor_id=vendor_id)[:limit]


# ---------------------------------------------------------------------------
# Withdrawal fees — static 5% + plan-based Safaricom split
# ---------------------------------------------------------------------------

GMARKETFY_FEE_RATE = Decimal("0.05")

# Safaricom B2C fee by amount band (Option 1 — Standard).
# Capped at KSh 13.
SAFARICOM_B2C_BANDS = [
    (Decimal("100"),    Decimal("0")),
    (Decimal("1500"),   Decimal("5")),
    (Decimal("5000"),   Decimal("9")),
    (Decimal("20000"),  Decimal("11")),
    (Decimal("250000"), Decimal("13")),
]

# Fallback if the plan doesn't specify a share
DEFAULT_SAFARICOM_SHARE = Decimal("0.00")


def safaricom_b2c_fee(amount: Decimal) -> Decimal:
    """Returns the Safaricom B2C fee for a given withdrawal amount."""
    for cap, fee in SAFARICOM_B2C_BANDS:
        if amount <= cap:
            return fee
    return Decimal("13")


def get_vendor_plan_slug(vendor_id):
    """Returns the vendor's active plan slug, or 'free' if none."""
    from vendors_plans.models import VendorSubscription

    sub = (
        VendorSubscription.objects
        .select_related("plan")
        .filter(vendor_id=vendor_id, status=VendorSubscription.STATUS_ACTIVE)
        .first()
    )
    return sub.plan.slug if sub and sub.plan else "free"


def get_plan_safaricom_share(vendor_id) -> Decimal:
    """
    How much of the Safaricom B2C fee Gmarketfy absorbs, as a Decimal
    fraction (0.00 = vendor pays all, 1.00 = we pay all).
    """
    from vendors_plans.models import VendorSubscription

    sub = (
        VendorSubscription.objects
        .select_related("plan")
        .filter(vendor_id=vendor_id, status=VendorSubscription.STATUS_ACTIVE)
        .first()
    )

    if sub and sub.plan and isinstance(sub.plan.limits, dict):
        raw = sub.plan.limits.get("safaricom_share")
        if raw is not None:
            try:
                return Decimal(str(raw))
            except Exception:
                pass

    return DEFAULT_SAFARICOM_SHARE


def get_plan_min_withdrawal(vendor_id) -> Decimal:
    """
    The minimum withdrawal amount for the vendor's active plan.
    Falls back to WITHDRAWAL_MIN_AMOUNT if no plan is active or the
    plan doesn't specify one.
    """
    from vendors_plans.models import VendorSubscription

    sub = (
        VendorSubscription.objects
        .select_related("plan")
        .filter(vendor_id=vendor_id, status=VendorSubscription.STATUS_ACTIVE)
        .first()
    )

    if sub and sub.plan and isinstance(sub.plan.limits, dict):
        raw = sub.plan.limits.get("instant_min")
        if raw is not None:
            try:
                return Decimal(str(raw))
            except Exception:
                pass

    return Decimal(str(settings.WITHDRAWAL_MIN_AMOUNT))


def calculate_withdrawal_charges(vendor_id, amount: Decimal) -> dict:
    """
    Full breakdown of a withdrawal's fees.

    All amounts are rounded to whole shillings — M-Pesa wallets don't hold
    cents, so anything fractional here would show the vendor one number
    and pay them another. The Gmarketfy fee and the vendor's Safaricom
    share round to the nearest shilling (0.5 rounds up). Net is derived
    from the rounded values so the arithmetic always reconciles.
    """
    # Normalize the requested amount to a whole shilling
    amount = amount.quantize(Decimal("1"), rounding=ROUND_HALF_UP)

    # 5% Gmarketfy fee, rounded to nearest shilling
    raw_gmk = (amount * GMARKETFY_FEE_RATE).quantize(Decimal("0.01"))
    gmarketfy_fee = raw_gmk.quantize(Decimal("1"), rounding=ROUND_HALF_UP)

    # Safaricom's B2C fee (already whole)
    saf_total = safaricom_b2c_fee(amount)

    # Vendor's share of the Safaricom fee, rounded to nearest shilling
    g_share = get_plan_safaricom_share(vendor_id)
    raw_vendor_share = saf_total * (Decimal("1") - g_share)
    saf_vendor_pays = raw_vendor_share.quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    saf_g_absorbs = saf_total - saf_vendor_pays

    net = amount - gmarketfy_fee - saf_vendor_pays

    return {
        "gmarketfy_fee": gmarketfy_fee,
        "safaricom_fee_total": saf_total,
        "safaricom_fee_vendor_pays": saf_vendor_pays,
        "safaricom_fee_gmarketfy_absorbs": saf_g_absorbs,
        "net_to_vendor": net,
    }


# ---------------------------------------------------------------------------
# Withdrawal creation
# ---------------------------------------------------------------------------

def create_withdrawal(vendor_id, amount: Decimal):
    """
    Atomic: validate balance, snapshot destination, create Withdrawal row,
    debit the ledger, then fire B2C.

    Returns (withdrawal_or_None, error_message_or_None).
    """
    # Global floor — applies to everyone
    global_min = Decimal(str(settings.WITHDRAWAL_MIN_AMOUNT))
    if amount < global_min:
        return None, f"Minimum withdrawal is KSh {global_min:.0f}."

    # Plan-based minimum — applies to the vendor's current subscription
    plan_min = get_plan_min_withdrawal(vendor_id)
    if amount < plan_min:
        plan_slug = get_vendor_plan_slug(vendor_id)
        plan_name = plan_slug.capitalize()
        return None, (
            f"Your {plan_name} plan requires a minimum withdrawal of "
            f"KSh {plan_min:.0f}. Upgrade to withdraw smaller amounts."
        )

    bal = get_vendor_balance(vendor_id)
    if amount > bal["balance"]:
        return None, "Amount exceeds available balance."

    dest = VendorPayoutDestination.objects.filter(vendor_id=vendor_id).first()
    if not dest:
        return None, "Set a payout phone number before withdrawing."

    # Normalize amount to whole shillings — matches what we'll actually send
    amount = amount.quantize(Decimal("1"), rounding=ROUND_HALF_UP)

    charges = calculate_withdrawal_charges(vendor_id, amount)
    fee = charges["gmarketfy_fee"]
    net = charges["net_to_vendor"]

    if net <= 0:
        return None, "Amount is too small after fees."

    try:
        with db_transaction.atomic():
            inflight = Withdrawal.objects.select_for_update().filter(
                vendor_id=vendor_id,
                status__in=[Withdrawal.STATUS_PENDING, Withdrawal.STATUS_PROCESSING],
            ).exists()
            if inflight:
                return None, "You already have a withdrawal in progress."

            w = Withdrawal.objects.create(
                vendor_id=vendor_id,
                amount=amount,
                fee=fee,
                net_amount=net,
                safaricom_fee_total=charges["safaricom_fee_total"],
                safaricom_fee_vendor_pays=charges["safaricom_fee_vendor_pays"],
                safaricom_fee_gmarketfy_absorbs=charges["safaricom_fee_gmarketfy_absorbs"],
                phone=dest.phone,
                status=Withdrawal.STATUS_PENDING,
            )

            entry = WalletLedgerEntry.objects.create(
                vendor_id=vendor_id,
                kind=WalletLedgerEntry.KIND_DEBIT,
                amount=amount,
                source_type=WalletLedgerEntry.SOURCE_WITHDRAWAL,
                source_id=str(w.id),
                description=f"Withdrawal #{str(w.id)[:8]}",
            )
            w.ledger_entry = entry
            w.save(update_fields=["ledger_entry"])
    except IntegrityError:
        return None, "Another withdrawal is being created right now. Try again."

    result = execute_b2c_payout(
        amount=net,
        phone_number=dest.phone,
        remarks=f"Withdrawal #{str(w.id)[:8]}",
    )

    if not result["success"]:
        _mark_failed_and_reverse(w, reason=result.get("error", "B2C request rejected"))
        w.refresh_from_db()
        return w, None

    data = result["data"]
    w.conversation_id = data.get("ConversationID")
    w.originator_id = data.get("OriginatorConversationID")
    w.status = Withdrawal.STATUS_PROCESSING
    w.save(update_fields=["conversation_id", "originator_id", "status", "updated_at"])

    return w, None


# ---------------------------------------------------------------------------
# B2C callbacks
# ---------------------------------------------------------------------------

def _write_reversal_credit(w):
    """Compensating credit that restores a debited amount. Idempotent."""
    try:
        return WalletLedgerEntry.objects.create(
            vendor_id=w.vendor_id,
            kind=WalletLedgerEntry.KIND_CREDIT,
            amount=w.amount,
            source_type=WalletLedgerEntry.SOURCE_ADJUSTMENT,
            source_id=f"reversal-{w.id}",
            description=f"Reversal for failed withdrawal #{str(w.id)[:8]}",
        )
    except IntegrityError:
        return WalletLedgerEntry.objects.filter(
            vendor_id=w.vendor_id,
            kind=WalletLedgerEntry.KIND_CREDIT,
            source_type=WalletLedgerEntry.SOURCE_ADJUSTMENT,
            source_id=f"reversal-{w.id}",
        ).first()


def _mark_failed_and_reverse(withdrawal, reason):
    """Terminal-fail a withdrawal + reverse the ledger debit."""
    with db_transaction.atomic():
        w = Withdrawal.objects.select_for_update().get(pk=withdrawal.pk)
        if w.status in (Withdrawal.STATUS_SUCCEEDED, Withdrawal.STATUS_FAILED):
            return

        reversal = _write_reversal_credit(w)
        w.status = Withdrawal.STATUS_FAILED
        w.result_description = reason
        w.reversal_entry = reversal
        w.completed_at = timezone.now()
        w.save(update_fields=[
            "status", "result_description", "reversal_entry",
            "completed_at", "updated_at",
        ])


def handle_b2c_result(originator_id, result_body):
    """Called from the B2C ResultURL callback. Idempotent."""
    with db_transaction.atomic():
        w = Withdrawal.objects.select_for_update().filter(
            originator_id=originator_id
        ).first()
        if w is None:
            logger.warning("handle_b2c_result: no withdrawal for originator_id=%s", originator_id)
            return None

        if w.status in (Withdrawal.STATUS_SUCCEEDED, Withdrawal.STATUS_FAILED):
            return w

        result = (result_body or {}).get("Result", {})
        w.raw_result = result_body
        w.result_code = result.get("ResultCode")
        w.result_description = result.get("ResultDesc")

        if result.get("ResultCode") == 0:
            params = {
                p.get("Key"): p.get("Value")
                for p in (result.get("ResultParameters", {}).get("ResultParameter", []) or [])
            }
            w.mpesa_receipt_number = (
                params.get("TransactionReceipt") or result.get("TransactionID")
            )
            w.status = Withdrawal.STATUS_SUCCEEDED
            w.completed_at = timezone.now()
            w.save(update_fields=[
                "raw_result", "result_code", "result_description",
                "mpesa_receipt_number", "status", "completed_at", "updated_at",
            ])
        else:
            reversal = _write_reversal_credit(w)
            w.status = Withdrawal.STATUS_FAILED
            w.completed_at = timezone.now()
            w.reversal_entry = reversal
            w.save(update_fields=[
                "raw_result", "result_code", "result_description",
                "status", "completed_at", "reversal_entry", "updated_at",
            ])

        return w