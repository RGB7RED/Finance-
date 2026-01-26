create extension if not exists "pgcrypto";

create table if not exists public.users (
    id uuid primary key default gen_random_uuid(),
    telegram_id bigint unique not null,
    username text,
    first_name text,
    last_name text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.budgets (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users(id) on delete cascade,
    type text not null check (type in ('personal', 'business')),
    name text not null,
    created_at timestamptz not null default now(),
    unique (user_id, type)
);

create table if not exists public.accounts (
    id uuid primary key default gen_random_uuid(),
    budget_id uuid not null references public.budgets(id) on delete cascade,
    name text not null,
    kind text not null check (kind in ('cash', 'bank')),
    currency text not null default 'RUB',
    created_at timestamptz not null default now(),
    unique (budget_id, name)
);

create table if not exists public.categories (
    id uuid primary key default gen_random_uuid(),
    budget_id uuid not null references public.budgets(id) on delete cascade,
    name text not null,
    parent_id uuid null references public.categories(id) on delete set null,
    created_at timestamptz not null default now(),
    unique (budget_id, name, parent_id)
);

create table if not exists public.transactions (
    id uuid primary key default gen_random_uuid(),
    budget_id uuid not null references public.budgets(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    date date not null,
    type text not null check (type in ('income', 'expense', 'transfer')),
    amount integer not null check (amount > 0),
    account_id uuid null references public.accounts(id) on delete cascade,
    to_account_id uuid null references public.accounts(id) on delete cascade,
    category_id uuid null references public.categories(id) on delete set null,
    tag text not null check (tag in ('one_time', 'subscription')),
    note text null,
    created_at timestamptz not null default now(),
    check (
        (
            type in ('income', 'expense')
            and account_id is not null
            and to_account_id is null
        )
        or (
            type = 'transfer'
            and account_id is not null
            and to_account_id is not null
            and account_id <> to_account_id
        )
    ),
    check ((type = 'income' and category_id is null) or type <> 'income'),
    check ((type = 'transfer' and category_id is null) or type <> 'transfer')
);

create table if not exists public.daily_state (
    id uuid primary key default gen_random_uuid(),
    budget_id uuid not null references public.budgets(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    date date not null,
    cash_total integer not null default 0 check (cash_total >= 0),
    bank_total integer not null default 0 check (bank_total >= 0),
    debt_cards_total integer not null default 0 check (debt_cards_total >= 0),
    debt_other_total integer not null default 0 check (debt_other_total >= 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (budget_id, date)
);

create table if not exists public.debts_other (
    id uuid primary key default gen_random_uuid(),
    budget_id uuid not null references public.budgets(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    name text not null,
    amount integer not null check (amount >= 0),
    note text null,
    created_at timestamptz not null default now()
);

create index if not exists debts_other_budget_user_idx
    on public.debts_other (budget_id, user_id);
