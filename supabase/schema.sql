create extension if not exists "pgcrypto";

create table if not exists public.users (
    id uuid primary key,
    telegram_id bigint null,
    username text null,
    first_name text null,
    last_name text null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

/*
MIGRATION (run manually in Supabase SQL editor if users.id was generated):
1. Add a temporary column to hold Supabase Auth IDs:
   alter table public.users add column if not exists auth_id uuid;
2. For each existing user, set auth_id to the corresponding auth.users.id
   (match manually using telegram_id/email/etc. as appropriate for your data):
   -- example:
   -- update public.users set auth_id = '<supabase-auth-uuid>' where telegram_id = <telegram_id>;
3. Update budgets to point to the new IDs:
   update public.budgets b
   set user_id = u.auth_id
   from public.users u
   where b.user_id = u.id;
4. Drop the old primary key and replace with auth_id:
   alter table public.users drop constraint users_pkey;
   alter table public.users alter column id drop default;
   update public.users set id = auth_id;
   alter table public.users drop column auth_id;
   alter table public.users add primary key (id);
*/

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
