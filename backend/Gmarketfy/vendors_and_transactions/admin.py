from django.contrib import admin

from .models import Transactions


@admin.register(Transactions)
class customtransactionviewfromadmin(admin.ModelAdmin):
    list_display = ('order_id', 'subtotal', 'phone_number', 'status', 'created_at', 'has_delivery', 'updated_at', 'vendor_id', 'product_id', 'client_id', 'checkout_request_id', 'merchant_request_id', 'mpesa_receipt_number', 'result_code', 'result_description', 'amount_paid', 'payment_timing')
    search_fields = ('order_id', 'phone_number', 'status', 'vendor_id', 'product_id', 'client_id', 'checkout_request_id', 'mpesa_receipt_number')
    list_filter = ('status', 'has_delivery', 'payment_timing', 'created_at', 'updated_at')