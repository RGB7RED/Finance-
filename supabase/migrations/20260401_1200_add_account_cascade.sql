ALTER TABLE transactions
DROP CONSTRAINT IF EXISTS transactions_account_id_fkey;

ALTER TABLE transactions
ADD CONSTRAINT transactions_account_id_fkey
FOREIGN KEY (account_id)
REFERENCES accounts(id)
ON DELETE CASCADE;
