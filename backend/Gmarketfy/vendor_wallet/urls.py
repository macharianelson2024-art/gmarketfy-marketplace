from django.urls import path
from . import views

app_name = "vendor_wallet"

urlpatterns = [
    path("summary", views.vault_summary_view, name="vault-summary"),

    path("payout-destination", views.payout_destination_view, name="payout-destination"),
    path("payout-destination/history", views.payout_destination_history_view, name="payout-destination-history"),

    path("withdraw", views.withdraw_view, name="withdraw"),
    path("withdraw/preview", views.withdrawal_preview_view, name="withdraw-preview"),
    path("withdrawals", views.withdrawals_list_view, name="withdrawals-list"),
    path("withdrawals/<uuid:withdrawal_id>", views.withdrawal_status_view, name="withdrawal-status"),

    path("b2c/result", views.b2c_result_callback, name="b2c-result"),
    path("b2c/timeout", views.b2c_timeout_callback, name="b2c-timeout"),
]