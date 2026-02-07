alter table public.statement_drafts
    drop constraint if exists statement_drafts_status_check;

alter table public.statement_drafts
    add constraint statement_drafts_status_check
    check (status in ('draft', 'revised', 'applied', 'failed'));
