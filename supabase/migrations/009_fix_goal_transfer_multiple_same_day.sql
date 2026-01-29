alter table public.account_balance_events
    add column if not exists transaction_id uuid;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'account_balance_events_transaction_id_fkey'
    ) then
        alter table public.account_balance_events
            add constraint account_balance_events_transaction_id_fkey
            foreign key (transaction_id)
            references public.transactions(id)
            on delete cascade;
    end if;
end $$;

alter table public.account_balance_events
    drop constraint if exists account_balance_events_unique;

drop index if exists account_balance_events_unique;
drop index if exists account_balance_events_manual_unique;

create unique index if not exists account_balance_events_manual_unique
    on public.account_balance_events (budget_id, user_id, date, account_id, reason)
    where reason = 'manual_adjust';

drop index if exists account_balance_events_tx_unique;

create unique index if not exists account_balance_events_tx_unique
    on public.account_balance_events (transaction_id)
    where transaction_id is not null;
