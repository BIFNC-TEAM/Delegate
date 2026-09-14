-- A STARTED MemoryUseRun must remain pinned to the active episode while it is
-- open. Terminalization is different: the same generation may atomically
-- create its verified output and move the conversation to NEEDS_HUMAN before
-- the memory ledger is closed. Keep all generation/output/version checks, but
-- do not require the episode to remain ACTIVE for that terminal update.
DO $migration$
DECLARE
  function_definition TEXT;
  old_clause CONSTANT TEXT := $old$
    require_current_episode := OLD."status" = 'STARTED'::"MemoryUseRunStatus";
$old$;
  new_clause CONSTANT TEXT := $new$
    require_current_episode :=
      OLD."status" = 'STARTED'::"MemoryUseRunStatus"
      AND NEW."status" = 'STARTED'::"MemoryUseRunStatus";
$new$;
BEGIN
  SELECT pg_get_functiondef('memory_use_run_channel_guard()'::regprocedure)
    INTO function_definition;

  IF POSITION(old_clause IN function_definition) = 0 THEN
    RAISE EXCEPTION 'memory_use_run_channel_guard definition is not the expected version';
  END IF;

  EXECUTE REPLACE(function_definition, old_clause, new_clause);
END;
$migration$;
