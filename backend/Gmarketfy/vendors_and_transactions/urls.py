from django.urls import path
from . import views


from .views import (
    b2c_result_callback,
    b2c_timeout_callback,
    send_test_payout_view,
)


urlpatterns = [
    path(
        "payments/test-payout/",
        send_test_payout_view,
        name="send_test_payout",
    ),
    path(
        "payments/b2c/result/",
        b2c_result_callback,
        name="b2c_result_callback",
    ),
    path(
        "payments/b2c/timeout/",
        b2c_timeout_callback,
        name="b2c_timeout_callback",
    ),
    path('pay/<str:order_id>/', views.payments_view, name='payments'),
    path("payments/callback/", views.payments_callback, name="payments_callback"),
    path('sendtoyourself/', views.send_test_payout, name='send_b2c_payout'),
    path("b2c/result/", views.b2c_result_callback, name="b2c_result_callback"),
    path("b2c/timeout/", views.b2c_timeout_callback, name="b2c_timeout_callback"),
]