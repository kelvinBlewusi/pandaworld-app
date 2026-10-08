-- The test set can run through the step-2 prototype ("one front door",
-- lib/assistant-v2/front-door.ts) beside the chat as it is. Older runs are
-- the current pipeline. `asked`: cases where the prototype asked the seller
-- a question back instead of acting.
alter table assistant_eval_runs
  add column if not exists pipeline text not null default 'current',
  add column if not exists router_model text,
  add column if not exists asked int not null default 0;
