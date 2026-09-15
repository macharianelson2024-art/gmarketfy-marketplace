from django.utils import timezone
from rest_framework import serializers

from .models import Plan, VendorSubscription, PlanPayment


class PlanSerializer(serializers.ModelSerializer):
    class Meta:
        model = Plan
        fields = [
            "id", "name", "slug", "description", "price", "currency",
            "billing_cycle", "duration_days", "tier", "features",
            "limits", "display_order",
        ]


class VendorSubscriptionSerializer(serializers.ModelSerializer):
    plan = PlanSerializer(read_only=True)
    days_remaining = serializers.SerializerMethodField()

    class Meta:
        model = VendorSubscription
        fields = ["id", "plan", "started_at", "expires_at", "status", "days_remaining"]

    def get_days_remaining(self, obj):
        delta = obj.expires_at - timezone.now()
        return max(delta.days, 0)


class PlanPaymentSerializer(serializers.ModelSerializer):
    plan = PlanSerializer(read_only=True)

    class Meta:
        model = PlanPayment
        fields = [
            "id", "transaction_reference", "plan", "change_type", "amount",
            "phone_number", "status", "mpesa_receipt_number",
            "result_description", "created_at", "updated_at",
        ]


class UpgradePlanRequestSerializer(serializers.Serializer):
    plan_id = serializers.IntegerField()
    phone = serializers.CharField(required=False, allow_blank=True)
    
class PlanPaymentStatusSerializer(serializers.ModelSerializer):
    plan = PlanSerializer(read_only=True)

    class Meta:
        model = PlanPayment
        fields = [
            "transaction_reference", "plan", "change_type", "amount",
            "phone_number", "status", "mpesa_receipt_number",
            "result_description", "created_at", "updated_at",
        ]