from django.db import models

import uuid
class WalletLedgerEntry(models.Model):
    """
    Append-only ledger of every shilling in or out of a vendor's wallet.

    Balance is derived from this table (never stored as a mutable field), so
    the ledger is the single source of truth. Rows are never updated — a
    mistake is corrected by writing a compensating entry.

    Idempotency: the unique constraint on (vendor_id, kind, source_type,
    source_id) makes it impossible to double-credit the same payment, no
    matter how many times the callback or backfill runs.
    """

    KIND_CREDIT = "credit"
    KIND_DEBIT  = "debit"
    KIND_CHOICES = [
        (KIND_CREDIT, "Credit"),
        (KIND_DEBIT,  "Debit"),
    ]

    SOURCE_ORDER_PAYMENT = "order_payment"
    SOURCE_WITHDRAWAL    = "withdrawal"
    SOURCE_ADJUSTMENT    = "adjustment"
    SOURCE_CHOICES = [
        (SOURCE_ORDER_PAYMENT, "Order payment"),
        (SOURCE_WITHDRAWAL,    "Withdrawal"),
        (SOURCE_ADJUSTMENT,    "Manual adjustment"),
    ]

    vendor_id   = models.CharField(max_length=200, db_index=True)
    kind        = models.CharField(max_length=10, choices=KIND_CHOICES)
    amount      = models.DecimalField(max_digits=12, decimal_places=2)
    source_type = models.CharField(max_length=30, choices=SOURCE_CHOICES)
    source_id   = models.CharField(max_length=200, db_index=True)
    description = models.CharField(max_length=255, blank=True)
    created_at  = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["vendor_id", "kind", "source_type", "source_id"],
                name="unique_wallet_entry_per_source",
            ),
        ]
        indexes = [
            models.Index(fields=["vendor_id", "kind"]),
        ]

    def __str__(self):
        return f"{self.vendor_id} {self.kind} {self.amount} ({self.source_type}:{self.source_id})"


class VendorPayoutDestination(models.Model):
    """
    Where a vendor's withdrawals go. One row per vendor, upserted on change.

    Kept separate from the audit table so the "current" lookup is a single
    row read — the audit table grows unbounded, this stays O(1).
    """
    TYPE_TILL    = "till"
    TYPE_PAYBILL = "paybill"
    TYPE_CHOICES = [
        (TYPE_TILL,    "Till"),
        (TYPE_PAYBILL, "Paybill"),
    ]

    vendor_id      = models.CharField(max_length=200, unique=True, db_index=True)
    type           = models.CharField(max_length=10, choices=TYPE_CHOICES)
    number         = models.CharField(max_length=20)
    account_number = models.CharField(max_length=50, blank=True, null=True)  # paybill only
    phone          = models.CharField(max_length=15, blank=True, null=True)  # M-Pesa SIM that owns the till/paybill
    created_at     = models.DateTimeField(auto_now_add=True)
    updated_at     = models.DateTimeField(auto_now=True)

    def __str__(self):
        suffix = f" / {self.account_number}" if self.account_number else ""
        return f"{self.vendor_id} → {self.type} {self.number}{suffix}"


class PayoutDestinationChange(models.Model):
    """
    Append-only audit of every payout-destination change.

    Security-sensitive: if a vendor's M-Pesa destination is ever compromised,
    this is the record of exactly when and what changed.
    """
    vendor_id          = models.CharField(max_length=200, db_index=True)
    old_type           = models.CharField(max_length=10, blank=True, null=True)
    old_number         = models.CharField(max_length=20, blank=True, null=True)
    old_account_number = models.CharField(max_length=50, blank=True, null=True)
    old_phone          = models.CharField(max_length=15, blank=True, null=True)

    new_type           = models.CharField(max_length=10)
    new_number         = models.CharField(max_length=20)
    new_account_number = models.CharField(max_length=50, blank=True, null=True)
    new_phone          = models.CharField(max_length=15, blank=True, null=True)

    changed_at         = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-changed_at"]
        indexes = [
            models.Index(fields=["vendor_id", "-changed_at"]),
        ]

    def __str__(self):
        return f"{self.vendor_id} changed at {self.changed_at}"


class Withdrawal(models.Model):
    """
    One B2C payout to a vendor. Debits the wallet ledger up front so the
    vendor can't double-spend; on failure, a reversing credit restores it.
    """
    STATUS_PENDING    = "pending"
    STATUS_PROCESSING = "processing"
    STATUS_SUCCEEDED  = "succeeded"
    STATUS_FAILED     = "failed"
    STATUS_CHOICES = [
        (STATUS_PENDING,    "Pending"),
        (STATUS_PROCESSING, "Processing"),
        (STATUS_SUCCEEDED,  "Succeeded"),
        (STATUS_FAILED,     "Failed"),
    ]

    id         = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    vendor_id  = models.CharField(max_length=200, db_index=True)
    amount     = models.DecimalField(max_digits=12, decimal_places=2)
    fee        = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    net_amount = models.DecimalField(max_digits=12, decimal_places=2)

    # Destination snapshot — never mutate. If the vendor changes their
    # payout destination later, this record still says where THIS
    # withdrawal went.
    destination_type    = models.CharField(max_length=10, blank=True, null=True)
    destination_number  = models.CharField(max_length=20, blank=True, null=True)
    destination_account = models.CharField(max_length=50, blank=True, null=True)
    phone               = models.CharField(max_length=15)

    status       = models.CharField(max_length=20, default=STATUS_PENDING, choices=STATUS_CHOICES)
    ledger_entry = models.ForeignKey(
        WalletLedgerEntry,
        null=True, blank=True,
        on_delete=models.SET_NULL,
        related_name="withdrawals",
    )
    reversal_entry = models.ForeignKey(
        WalletLedgerEntry,
        null=True, blank=True,
        on_delete=models.SET_NULL,
        related_name="reversed_withdrawals",
    )

    # Daraja B2C fields
    conversation_id      = models.CharField(max_length=100, blank=True, null=True, db_index=True)
    originator_id        = models.CharField(max_length=100, blank=True, null=True, db_index=True)
    mpesa_receipt_number = models.CharField(max_length=100, blank=True, null=True)
    result_code          = models.IntegerField(null=True, blank=True)
    result_description   = models.TextField(blank=True, null=True)
    raw_result           = models.JSONField(null=True, blank=True)

    requested_at = models.DateTimeField(auto_now_add=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    updated_at   = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-requested_at"]
        indexes = [
            models.Index(fields=["vendor_id", "-requested_at"]),
            models.Index(fields=["status"]),
        ]

    def __str__(self):
        return f"{self.vendor_id} - KSh {self.amount} ({self.status})"