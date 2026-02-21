CREATE TABLE IF NOT EXISTS debt_entities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE debts
ADD COLUMN IF NOT EXISTS debt_entity_id UUID
REFERENCES debt_entities(id)
ON DELETE CASCADE;

ALTER TABLE debts
DROP COLUMN IF EXISTS type;
