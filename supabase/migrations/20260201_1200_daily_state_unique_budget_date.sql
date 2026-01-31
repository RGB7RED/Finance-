with ranked as (
    select
        id,
        row_number() over (
            partition by budget_id, date
            order by created_at desc, id desc
        ) as rn
    from public.daily_state
)
delete from public.daily_state
using ranked
where public.daily_state.id = ranked.id
  and ranked.rn > 1;

do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'daily_state_budget_date_unique'
    ) then
        alter table public.daily_state
            add constraint daily_state_budget_date_unique unique (budget_id, date);
    end if;
end $$;
