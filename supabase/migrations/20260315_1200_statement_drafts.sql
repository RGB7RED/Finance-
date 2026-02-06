create table if not exists public.statement_drafts (
    id uuid primary key default gen_random_uuid(),
    budget_id uuid not null references public.budgets(id) on delete cascade,
    user_id uuid not null references public.users(id) on delete cascade,
    status text not null check (status in ('draft', 'revised', 'applied')),
    source_filename text,
    source_mime text,
    source_text text,
    model text,
    draft_payload jsonb not null,
    feedback text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists statement_drafts_budget_user_idx
    on public.statement_drafts (budget_id, user_id);
