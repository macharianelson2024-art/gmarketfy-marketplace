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

logger = logging.getLogger(__name__)


# Permissive validation — real-world paybill/till numbers and account
# references vary too much to pin down with a strict regex. We only block
# obviously-wrong input (empty, absurdly long, control chars) and let the
# M-Pesa network be the real authority on whether a destination is valid.
_NUMBER_RE  = re.compile(r"^\d{3,12}$")
_ACCOUNT_RE = re.compile(r"^[\w\-. /#@+,:()&']{1,100}$", re.UNICODE)
_PHONE_RE   = re.compile(r"^254\d{9}$")


# ---------------------------------------------------------------------------
# Balance
# ---------------------------------------------------------------------------

def get_vendor_balance(vendor_id):
    """
    Returns { balance, pendingBalance } for a vendor.

    balance        = total credits - total debits  (all time)
    pendingBalance = always 0 for now — will reflect in-flight withdrawals
                     once we track them separately from available balance.
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
    Creates a credit entry for a completed order payment. Idempotent.
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
# Payout destination
# ---------------------------------------------------------------------------

def _normalize_phone(raw):
    p = str(raw or "").strip().replace(" ", "").replace("-", "")
    if p.startswith("+254"):
        p = "254" + p[4:]
    elif p.startswith("07") or p.startswith("01"):
        p = "254" + p[1:]
    return p


def validate_payout_destination(type_, number, account_number=None, phone=None):
    """
    Returns (cleaned_dict, error_message_or_None).
    Permissive on numbers; strict on phone (B2C requires 2547XXXXXXXX).
    """
    type_ = (type_ or "").strip().lower()
    number = (number or "").strip()
    account_number = (account_number or "").strip() or None
    phone_clean = _normalize_phone(phone) if phone else None

    if type_ not in (VendorPayoutDestination.TYPE_TILL, VendorPayoutDestination.TYPE_PAYBILL):
        return None, "Destination type must be 'till' or 'paybill'."

    if not number:
        return None, "Business number is required."

    if not _NUMBER_RE.match(number):
        return None, "Business number must be 3–12 digits."

    if type_ == VendorPayoutDestination.TYPE_TILL:
        if account_number and not _ACCOUNT_RE.match(account_number):
            return None, "Account reference contains invalid characters or is too long."
    else:  # paybill
        if not account_number:
            return None, "Account number is required for Paybill destinations."
        if not _ACCOUNT_RE.match(account_number):
            return None, "Account reference contains invalid characters or is too long."

    if phone_clean and not _PHONE_RE.match(phone_clean):
        return None, "Payout phone must be a valid Kenyan M-Pesa number."

    return {
        "type": type_,
        "number": number,
        "account_number": account_number,
        "phone": phone_clean,
    }, None


def get_payout_destination(vendor_id):
    return VendorPayoutDestination.objects.filter(vendor_id=vendor_id).first()


@db_transaction.atomic
def set_payout_destination(vendor_id, type_, number, account_number=None, phone=None):
    """
    Upserts the destination + writes an audit row. No-op if unchanged.
    """
    cleaned, err = validate_payout_destination(type_, number, account_number, phone)
    if err:
        return None, err

    existing = VendorPayoutDestination.objects.select_for_update().filter(
        vendor_id=vendor_id
    ).first()

    if existing:
        if (
            existing.type == cleaned["type"]
            and existing.number == cleaned["number"]
            and (existing.account_number or None) == cleaned["account_number"]
            and (existing.phone or None) == cleaned["phone"]
        ):
            return existing, None

        PayoutDestinationChange.objects.create(
            vendor_id=vendor_id,
            old_type=existing.type,
            old_number=existing.number,
            old_account_number=existing.account_number,
            old_phone=existing.phone,
            new_type=cleaned["type"],
            new_number=cleaned["number"],
            new_account_number=cleaned["account_number"],
            new_phone=cleaned["phone"],
        )

        existing.type = cleaned["type"]
        existing.number = cleaned["number"]
        existing.account_number = cleaned["account_number"]
        existing.phone = cleaned["phone"]
        existing.save(update_fields=["type", "number", "account_number", "phone", "updated_at"])
        return existing, None

    dest = VendorPayoutDestination.objects.create(
        vendor_id=vendor_id,
        **cleaned,
    )

    PayoutDestinationChange.objects.create(
        vendor_id=vendor_id,
        old_type=None, old_number=None, old_account_number=None, old_phone=None,
        new_type=cleaned["type"],
        new_number=cleaned["number"],
        new_account_number=cleaned["account_number"],
        new_phone=cleaned["phone"],
    )

    return dest, None


def get_payout_destination_history(vendor_id, limit=50):
    return PayoutDestinationChange.objects.filter(vendor_id=vendor_id)[:limit]


# ---------------------------------------------------------------------------
# Withdrawal fees
# ---------------------------------------------------------------------------

def get_withdrawal_fee_pct(vendor_id):
    """
    Returns the fee percentage (Decimal fraction, e.g. Decimal("1.5") for 1.5%)
    based on the vendor's active plan's limits.withdrawal_fee_pct.
    """
    from vendors_plans.models import VendorSubscription

    DEFAULT_FEE_PCT = Decimal("1.5")

    sub = (
        VendorSubscription.objects
        .select_related("plan")
        .filter(vendor_id=vendor_id, status=VendorSubscription.STATUS_ACTIVE)
        .first()
    )

    if sub and sub.plan and isinstance(sub.plan.limits, dict):
        raw = sub.plan.limits.get("withdrawal_fee_pct")
        if raw is not None:
            try:
                return Decimal(str(raw))
            except Exception:
                pass

    return DEFAULT_FEE_PCT


def calculate_withdrawal_fee(vendor_id, amount: Decimal) -> Decimal:
    pct = get_withdrawal_fee_pct(vendor_id)
    fee = (amount * pct / Decimal("100")).quantize(Decimal("0.01"))
    return fee


# ---------------------------------------------------------------------------
# Withdrawal creation + orchestration
# ---------------------------------------------------------------------------

def create_withdrawal(vendor_id, amount: Decimal):
    """
    Atomic: validate balance, snapshot destination, create Withdrawal row,
    debit wallet ledger, then fire B2C.

    Returns (withdrawal, error_message).
    """
    min_amount = Decimal(str(settings.WITHDRAWAL_MIN_AMOUNT))
    if amount < min_amount:
        return None, f"Minimum withdrawal is KSh {min_amount}."

    bal = get_vendor_balance(vendor_id)
    if amount > bal["balance"]:
        return None, "Amount exceeds available balance."

    dest = VendorPayoutDestination.objects.filter(vendor_id=vendor_id).first()
    if not dest:
        return None, "Set a payout destination before withdrawing."
    if not dest.phone:
        return None, "Set a payout phone number before withdrawing."

    fee = calculate_withdrawal_fee(vendor_id, amount)
    net = (amount - fee).quantize(Decimal("0.01"))
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
                phone=dest.phone,
                destination_type=dest.type,
                destination_number=dest.number,
                destination_account=dest.account_number,
                status=Withdrawal.STATUS_PENDING,
            )

            # Debit immediately — prevents double-spend while B2C is in flight.
            entry = WalletLedgerEntry.objects.create(
                vendor_id=vendor_id,
                kind=WalletLedgerEntry.KIND_DEBIT,
                amount=amount,
                source_type=WalletLedgerEntry.SOURCE_WITHDRAWAL,
                source_id=str(w.id),
                description=f"Withdrawal #{w.id}",
            )
            w.ledger_entry = entry
            w.save(update_fields=["ledger_entry"])
    except IntegrityError:
        return None, "Another withdrawal is being created right now. Try again."

    # Fire B2C outside the transaction
    result = execute_b2c_payout(
        amount=net,
        phone_number=dest.phone,
        remarks=f"Withdrawal #{w.id}",
    )

    if not result["success"]:
        _fail_and_reverse(w, reason=result.get("error", "B2C request rejected"))
        w.refresh_from_db()
        return w, None

    data = result["data"]
    w.conversation_id = data.get("ConversationID")
    w.originator_id = data.get("OriginatorConversationID")
    w.status = Withdrawal.STATUS_PROCESSING
    w.save(update_fields=["conversation_id", "originator_id", "status", "updated_at"])

    return w, None


def _fail_and_reverse(withdrawal, reason):
    """
    Mark failed + write a compensating credit so balance is restored.
    Called when B2C was never accepted (network, invalid initiator, etc.).
    """
    with db_transaction.atomic():
        w = Withdrawal.objects.select_for_update().get(pk=withdrawal.pk)
        if w.status in (Withdrawal.STATUS_SUCCEEDED, Withdrawal.STATUS_FAILED):
            return  # already terminal

        reversal = WalletLedgerEntry.objects.create(
            vendor_id=w.vendor_id,
            kind=WalletLedgerEntry.KIND_CREDIT,
            amount=w.amount,
            source_type=WalletLedgerEntry.SOURCE_ADJUSTMENT,
            source_id=f"reversal-{w.id}",
            description=f"Reversal for failed withdrawal #{w.id}",
        )

        w.status = Withdrawal.STATUS_FAILED
        w.result_description = reason
        w.reversal_entry = reversal
        w.completed_at = timezone.now()
        w.save(update_fields=[
            "status", "result_description", "reversal_entry",
            "completed_at", "updated_at",
        ])


def handle_b2c_result(originator_id, result_body):
    """
    Called from the B2C ResultURL callback. Idempotent — repeat callbacks
    for a terminal withdrawal are no-ops.
    """
    with db_transaction.atomic():
        w = Withdrawal.objects.select_for_update().filter(
            originator_id=originator_id
        ).first()
        if w is None:
            return None

        if w.status in (Withdrawal.STATUS_SUCCEEDED, Withdrawal.STATUS_FAILED):
            return w  # duplicate callback — no-op

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
            w.status = Withdrawal.STATUS_FAILED
            w.completed_at = timezone.now()
            w.save(update_fields=[
                "raw_result", "result_code", "result_description",
                "status", "completed_at", "updated_at",
            ])

            reversal = WalletLedgerEntry.objects.create(
                vendor_id=w.vendor_id,
                kind=WalletLedgerEntry.KIND_CREDIT,
                amount=w.amount,
                source_type=WalletLedgerEntry.SOURCE_ADJUSTMENT,
                source_id=f"reversal-{w.id}",
                description=f"Reversal for failed withdrawal #{w.id}",
            )
            w.reversal_entry = reversal
            w.save(update_fields=["reversal_entry"])

        return w