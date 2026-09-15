from django.db import models

# Create your models here.

class Transactions(models.Model):
    transaction_reference = models.CharField(max_length=10, unique=True)
    order_id     = models.CharField(max_length=200)
    subtotal     = models.DecimalField(max_digits=10, decimal_places=2)
    phone_number = models.CharField(max_length=15)
    status       = models.CharField(max_length=50, default='initialized')
    created_at   = models.DateTimeField(auto_now_add=True)
    has_delivery = models.BooleanField(default=False)
    updated_at   = models.DateTimeField(auto_now=True)
    vendor_id    = models.CharField(max_length=200)  # was "vender_id" — fixed typo
    product_id   = models.CharField(max_length=200)
    client_id    = models.CharField(max_length=200)
    quantity     = models.IntegerField(default=1)
    transaction_description = models.CharField(max_length=200, null=True, blank=True)
    firestore_synced = models.BooleanField(default=False)
    
    
    checkout_request_id = models.CharField(max_length=100, null=True, blank=True)
    merchant_request_id = models.CharField(max_length=100, null=True, blank=True)
    mpesa_receipt_number = models.CharField(max_length=100, null=True, blank=True)
    result_code = models.IntegerField(null=True, blank=True)
    result_description = models.TextField(null=True, blank=True)

    # --- Added for the payments_callback rewrite ---------------------------
    payment_timing = models.CharField(max_length=10, default="before")  # snapshot of order.paymentTiming at initiation
    amount_paid = models.FloatField(null=True, blank=True)              # actual amount Daraja confirms was paid
    transaction_date_raw = models.CharField(max_length=20, null=True, blank=True)  # Daraja's raw YYYYMMDDHHMMSS
    callback_processed_at = models.DateTimeField(null=True, blank=True)
    raw_callback = models.JSONField(null=True, blank=True)              # full callback payload, for audits/debugging

    def __str__(self):
        return self.order_id
