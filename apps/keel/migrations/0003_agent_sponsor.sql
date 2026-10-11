-- An agent may name its sponsor: the human it acts on behalf of, carried in
-- its tokens as the `obo` claim. Null when the operator named none.
ALTER TABLE agents ADD COLUMN on_behalf_of TEXT;
