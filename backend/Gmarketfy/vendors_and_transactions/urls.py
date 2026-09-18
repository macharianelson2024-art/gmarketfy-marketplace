from django.urls import path
from . import views


urlpatterns = [
    path("pay/<str:order_id>/", views.payments_view, name="payments"),
    path("payments/callback/", views.payments_callback, name="payments_callback"),
    path(
        "payments/status/<str:transaction_reference>/",
        views.payment_status_view,
        name="payment_status",
    ),
]