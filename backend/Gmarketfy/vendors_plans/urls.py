from django.urls import path

from . import views

app_name = "vendors_plans"

urlpatterns = [
    path("plans/", views.list_plans_view, name="list-plans"),
    path("plans/current/", views.current_plan_view, name="current-plan"),
    path("plans/history/", views.payment_history_view, name="payment-history"),
    path("plans/upgrade/", views.upgrade_plan_view, name="upgrade-plan"),
    path("plans/payments/<str:transaction_reference>/", views.payment_status_view, name="payment-status"),
    path("plans/callback/", views.plans_callback, name="plans-callback"),
]