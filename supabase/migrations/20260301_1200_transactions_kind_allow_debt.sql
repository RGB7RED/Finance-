alter table public.transactions
    drop constraint if exists transactions_kind_check;

alter table public.transactions
    add constraint transactions_kind_check
    check (kind in ('normal', 'transfer', 'goal_transfer', 'debt'));
