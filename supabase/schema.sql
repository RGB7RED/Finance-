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
