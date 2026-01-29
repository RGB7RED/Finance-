alter table public.accounts
    add column if not exists active_from date not null default current_date;

do $$
begin
    if not exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'debts_other'
          and column_name = 'debt_type'
    ) then
        alter table public.debts_other
            add column debt_type text not null default 'people';
    end if;
end $$;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'debts_other_debt_type_check'
    ) then
        alter table public.debts_other
            add constraint debts_other_debt_type_check
            check (debt_type in ('people', 'cards'));
    end if;
end $$;
