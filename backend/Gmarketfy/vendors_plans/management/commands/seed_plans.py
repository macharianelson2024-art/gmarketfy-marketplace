from django.core.management.base import BaseCommand
from vendors_plans.models import Plan


PLANS = [
    {
        "slug": "free",
        "name": "Free", 
        "tier": 0, 
        "price": "0.00",
        "display_order": 0,
        "description": "Free starter plan for new vendors.",
        "features": ["Storefront", "Basic order management"],
        "limits": {
            "commission_label": "8–10%",
            "instant_min": 5000,
            "safaricom_share_label": "You pay the full Safaricom fee",
            "safaricom_share": 0.00,
            "payout_schedule": "Weekly batch payout",
        },
    },
    {
        "slug": "medium",
        "name": "Medium", 
        "tier": 1,
        "price": "1000.00",
        "display_order": 1,
        "description": "For growing vendors.",
        "features": ["Everything in Free", "More products", "Basic analytics"],
        "limits": {
            "commission_label": "5–6%",
            "instant_min": 3000,
            "safaricom_share_label": "We cover 50% of the Safaricom fee",
            "safaricom_share": 0.50,
            "payout_schedule": "Payout every 2–3 days",
        },
    },
    {
        "slug": "premium",
        "name": "Premium", 
        "tier": 2, 
        "price": "2500.00",
        "display_order": 2,
        "description": "For established vendors.",
        "features": ["Everything in Medium", "Priority support", "Advanced analytics"],
        "limits": {
            "commission_label": "3–4%",
            "instant_min": 1500,
            "safaricom_share_label": "We cover 80% of the Safaricom fee",
            "safaricom_share": 0.80,
            "payout_schedule": "Daily payout",
        },
    },
    {
        "slug": "ultimate", 
        "name": "Ultimate", 
        "tier": 3, 
        "price": "4000.00",
        "display_order": 3,
        "description": "Top tier for high-volume vendors.",
        "features": ["Everything in Premium", "Dedicated account manager"],
        "limits": {
            "commission_label": "1.5–2%",
            "instant_min": 500,
            "safaricom_share_label": "We cover 100% of the Safaricom fee",
            "safaricom_share": 1.00,
            "payout_schedule": "Instant, on-demand",
        },
    },
]


class Command(BaseCommand):
    help = "Seed the default plans (Free/Medium/Premium/Ultimate)."

    def handle(self, *args, **options):
        for p in PLANS:
            Plan.objects.update_or_create(
                slug=p["slug"],
                defaults={
                    "name": p["name"],
                    "tier": p["tier"],
                    "price": p["price"],
                    "description": p["description"],
                    "features": p["features"],
                    "limits": p["limits"],
                    "currency": "KES",
                    "billing_cycle": Plan.BILLING_MONTHLY,
                    "duration_days": 30,
                    "is_active": True,
                    "display_order": p["display_order"],
                },
            )
            self.stdout.write(self.style.SUCCESS(f"Seeded: {p['name']}"))