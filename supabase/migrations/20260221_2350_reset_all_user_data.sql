create or replace function public.reset_all_user_data(p_user_id uuid)
returns void
language plpgsql
security definer
as $$
begin
    delete from public.account_balance_events
    where budget_id in (select id from public.budgets where user_id = p_user_id);

    delete from public.transactions
    where budget_id in (select id from public.budgets where user_id = p_user_id);

    delete from public.goals
    where budget_id in (select id from public.budgets where user_id = p_user_id);

    delete from public.debts_other
    where budget_id in (select id from public.budgets where user_id = p_user_id);

    delete from public.daily_state
    where budget_id in (select id from public.budgets where user_id = p_user_id);

    delete from public.accounts
    where budget_id in (select id from public.budgets where user_id = p_user_id);

    delete from public.categories
    where budget_id in (select id from public.budgets where user_id = p_user_id);
end;
$$;
