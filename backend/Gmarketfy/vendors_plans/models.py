from django.db import models


class Plan(models.Model):
    BILLING_MONTHLY = "monthly"
    BILLING_YEARLY = "yearly"
    BILLING_CHOICES = [
        (BILLING_MONTHLY, "Monthly"),
        (BILLING_YEARLY, "Yearly"),
    ]

    name = models.CharField(max_length=50, unique=True)
    slug = models.SlugField(max_length=50, unique=True)
    description = models.TextField(blank=True)
    price = models.DecimalField(max_digits=10, decimal_places=2)  # KES
    currency = models.CharField(max_length=3, default="KES")
    billing_cycle = models.CharField(
        max_length=10, choices=BILLING_CHOICES, default=BILLING_MONTHLY
    )
    duration_days = models.PositiveIntegerField(default=30)
    # tier is the semantic rank used for upgrade/downgrade detection.
    # Prices change, promos exist, tiers are stable.
    tier = models.PositiveSmallIntegerField(default=0)
    features = models.JSONField(default=list, blank=True)  # ["...", "..."]
    limits = models.JSONField(default=dict, blank=True)    # {"max_products": 100}
    is_active = models.BooleanField(default=True)
    display_order = models.PositiveSmallIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["tier", "display_order"]

    def __str__(self):
        return f"{self.name} ({self.currency} {self.price}/{self.billing_cycle})"


class VendorSubscription(models.Model):
    STATUS_ACTIVE = "active"
    STATUS_EXPIRED = "expired"
    STATUS_CANCELLED = "cancelled"
    STATUS_CHOICES = [
        (STATUS_ACTIVE, "Active"),
        (STATUS_EXPIRED, "Expired"),
        (STATUS_CANCELLED, "Cancelled"),
    ]

    # Firestore vendor doc ID (Firebase UID). Not a FK — vendor lives in Firebase.
    vendor_id = models.CharField(max_length=200, db_index=True)
    plan = models.ForeignKey(Plan, on_delete=models.PROTECT, related_name="subscriptions")
    started_at = models.DateTimeField()
    expires_at = models.DateTimeField()
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_ACTIVE)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            # At most one active subscription per vendor.
            models.UniqueConstraint(
                fields=["vendor_id"],
                condition=models.Q(status="active"),
                name="unique_active_subscription_per_vendor",
            ),
        ]
        indexes = [
            models.Index(fields=["vendor_id", "status"]),
        ]

    def __str__(self):
        return f"{self.vendor_id} → {self.plan.name} ({self.status})"


class PlanPayment(models.Model):
    STATUS_INITIALIZED = "Initialized"
    STATUS_COMPLETED = "Completed"
    STATUS_FAILED = "Failed"
    STATUS_CHOICES = [
        (STATUS_INITIALIZED, "Initialized"),
        (STATUS_COMPLETED, "Completed"),
        (STATUS_FAILED, "Failed"),
    ]

    CHANGE_NEW = "new"
    CHANGE_UPGRADE = "upgrade"
    CHANGE_DOWNGRADE = "downgrade"
    CHANGE_RENEW = "renew"
    CHANGE_CHOICES = [
        (CHANGE_NEW, "New"),
        (CHANGE_UPGRADE, "Upgrade"),
        (CHANGE_DOWNGRADE, "Downgrade"),
        (CHANGE_RENEW, "Renew"),
    ]

    transaction_reference = models.CharField(max_length=10, unique=True)
    vendor_id = models.CharField(max_length=200, db_index=True)
    plan = models.ForeignKey(Plan, on_delete=models.PROTECT, related_name="payments")
    previous_subscription = models.ForeignKey(
        VendorSubscription,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="replaced_by",
    )
    change_type = models.CharField(max_length=10, choices=CHANGE_CHOICES)
    amount = models.DecimalField(max_digits=10, decimal_places=2)
    phone_number = models.CharField(max_length=15)
    status = models.CharField(max_length=20, default=STATUS_INITIALIZED, choices=STATUS_CHOICES)

    checkout_request_id = models.CharField(max_length=100, null=True, blank=True, db_index=True)
    merchant_request_id = models.CharField(max_length=100, null=True, blank=True)
    mpesa_receipt_number = models.CharField(max_length=100, null=True, blank=True)
    result_code = models.IntegerField(null=True, blank=True)
    result_description = models.TextField(null=True, blank=True)
    callback_processed_at = models.DateTimeField(null=True, blank=True)
    raw_callback = models.JSONField(null=True, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            # At most one in-flight payment per vendor — kills double-tap races.
            models.UniqueConstraint(
                fields=["vendor_id"],
                condition=models.Q(status="Initialized"),
                name="unique_initialized_payment_per_vendor",
            ),
        ]

    def __str__(self):
        return f"{self.transaction_reference} - {self.vendor_id} - {self.status}"