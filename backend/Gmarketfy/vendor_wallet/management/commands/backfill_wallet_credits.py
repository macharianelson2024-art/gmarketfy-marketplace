from django.core.management.base import BaseCommand
from django.db import IntegrityError

from vendors_and_transactions.models import Transactions
from vendor_wallet.models import WalletLedgerEntry


class Command(BaseCommand):
    help = "Backfill wallet credits for all Completed order payments."

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report what would be credited without writing.",
        )

    def handle(self, *args, **options):
        completed = Transactions.objects.filter(status="Completed")
        total = completed.count()
        self.stdout.write(f"Scanning {total} completed transactions...")

        created = 0
        skipped = 0

        for txn in completed.iterator():
            if not txn.vendor_id or txn.subtotal is None:
                skipped += 1
                continue

            if options["dry_run"]:
                exists = WalletLedgerEntry.objects.filter(
                    vendor_id=txn.vendor_id,
                    kind=WalletLedgerEntry.KIND_CREDIT,
                    source_type=WalletLedgerEntry.SOURCE_ORDER_PAYMENT,
                    source_id=txn.transaction_reference,
                ).exists()
                if exists:
                    skipped += 1
                else:
                    created += 1
                    self.stdout.write(
                        f"  [would credit] {txn.vendor_id} +{txn.subtotal} "
                        f"(ref {txn.transaction_reference})"
                    )
                continue

            try:
                _, was_created = WalletLedgerEntry.objects.get_or_create(
                    vendor_id=txn.vendor_id,
                    kind=WalletLedgerEntry.KIND_CREDIT,
                    source_type=WalletLedgerEntry.SOURCE_ORDER_PAYMENT,
                    source_id=txn.transaction_reference,
                    defaults={
                        "amount": txn.subtotal,
                        "description": f"Order {txn.order_id}",
                    },
                )
                if was_created:
                    created += 1
                else:
                    skipped += 1
            except IntegrityError:
                skipped += 1

        verb = "Would create" if options["dry_run"] else "Created"
        style = self.style.WARNING if options["dry_run"] else self.style.SUCCESS
        self.stdout.write(style(f"{verb} {created}, skipped (already present) {skipped}"))