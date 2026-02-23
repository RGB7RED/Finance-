ALTER TABLE public.categories
ADD COLUMN IF NOT EXISTS type text;

UPDATE public.categories
SET type = CASE
    WHEN kind = 'income' THEN 'income'
    ELSE 'expense'
END
WHERE type IS NULL;

ALTER TABLE public.categories
ALTER COLUMN type SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'categories_type_check'
          AND conrelid = 'public.categories'::regclass
    ) THEN
        ALTER TABLE public.categories
        ADD CONSTRAINT categories_type_check
        CHECK (type IN ('income', 'expense'));
    END IF;
END
$$;

DO $$
DECLARE
    c record;
BEGIN
    FOR c IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'public.transactions'::regclass
          AND contype = 'c'
          AND (
              pg_get_constraintdef(oid) ILIKE '%income%category_id is null%'
              OR pg_get_constraintdef(oid) ILIKE '%transfer%category_id is null%'
          )
    LOOP
        EXECUTE format('ALTER TABLE public.transactions DROP CONSTRAINT %I', c.conname);
    END LOOP;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'transactions_category_required_check'
          AND conrelid = 'public.transactions'::regclass
    ) THEN
        ALTER TABLE public.transactions
        ADD CONSTRAINT transactions_category_required_check
        CHECK (
            (type in ('income', 'expense') AND category_id is not null)
            OR (type = 'transfer' AND category_id is null)
        );
    END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.validate_transaction_category_type()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    category_type text;
BEGIN
    IF NEW.type IN ('income', 'expense') THEN
        IF NEW.category_id IS NULL THEN
            RAISE EXCEPTION 'Category is required';
        END IF;

        SELECT type INTO category_type
        FROM public.categories
        WHERE id = NEW.category_id;

        IF category_type IS NULL THEN
            RAISE EXCEPTION 'Category not found';
        END IF;

        IF category_type <> NEW.type THEN
            RAISE EXCEPTION 'Category type must match transaction type';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS transactions_validate_category_type_trigger ON public.transactions;

CREATE TRIGGER transactions_validate_category_type_trigger
BEFORE INSERT OR UPDATE ON public.transactions
FOR EACH ROW
EXECUTE FUNCTION public.validate_transaction_category_type();
