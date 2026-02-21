ALTER TABLE categories
ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'both';

-- Possible values:
-- 'income'
-- 'expense'
-- 'both'

ALTER TABLE transactions
ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES categories(id);
