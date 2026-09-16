from django.contrib import admin
from .models import (
    PayoutDestinationChange,
    VendorPayoutDestination,
    WalletLedgerEntry,
    Withdrawal,
)


@admin.register(WalletLedgerEntry)
class WalletLedgerEntryAdmin(admin.ModelAdmin):
    list_display = ("created_at", "vendor_id", "kind", "amount",
                    "source_type", "source_id", "description")
    list_filter = ("kind", "source_type")
    search_fields = ("vendor_id", "source_id", "description")
    readonly_fields = ("created_at",)
    ordering = ("-created_at",)


@admin.register(VendorPayoutDestination)
class VendorPayoutDestinationAdmin(admin.ModelAdmin):
    list_display = ("vendor_id", "type", "number", "account_number", "phone", "updated_at")
    list_filter = ("type",)
    search_fields = ("vendor_id", "number", "account_number", "phone")
    readonly_fields = ("created_at", "updated_at")


@admin.register(PayoutDestinationChange)
class PayoutDestinationChangeAdmin(admin.ModelAdmin):
    list_display = ("changed_at", "vendor_id",
                    "old_type", "old_number", "old_phone",
                    "new_type", "new_number", "new_phone")
    list_filter = ("new_type",)
    search_fields = ("vendor_id", "old_number", "new_number", "old_phone", "new_phone")
    readonly_fields = ("changed_at",)
    ordering = ("-changed_at",)

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False


@admin.register(Withdrawal)
class WithdrawalAdmin(admin.ModelAdmin):
    list_display = ("id", "vendor_id", "amount", "fee", "net_amount",
                    "status", "phone", "requested_at", "completed_at")
    list_filter = ("status", "destination_type")
    search_fields = ("vendor_id", "phone", "mpesa_receipt_number",
                     "conversation_id", "originator_id")
    readonly_fields = ("requested_at", "completed_at", "updated_at", "raw_result")
    ordering = ("-requested_at",)