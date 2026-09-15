from django.contrib import admin

from vendors_plans.models import Plan , VendorSubscription , PlanPayment


# Register your models here.

@admin.register(Plan)
class PlanAdmin(admin.ModelAdmin):
    list_display = ("name", "tier", "price", "billing_cycle", "currency", "is_active", "display_order")
    list_filter = ("tier", "billing_cycle", "is_active")
    search_fields = ("name",)
    
@admin.register(VendorSubscription)
class VendorSubscriptionAdmin(admin.ModelAdmin):
    list_display = ("vendor_id", "plan", "status", "started_at", "expires_at")
    list_filter = ("status",)
    search_fields = ("vendor_id",)
    
@admin.register(PlanPayment)
class PlanPaymentAdmin(admin.ModelAdmin):
    list_display = ("vendor_id", "plan", "amount", "status", "created_at")
    list_filter = ("status",)
    search_fields = ("vendor_id",)