# Fork backlog

Follow-up findings for this fork. GitHub issues are off on the fork, so findings that a change does not fix go here. Each entry gives the finding, its evidence, and why it was not fixed in the change that found it. Remove an entry when its fix merges.

## Restart continuations

- **Plugins get no typed signal that BB is continuing a cut turn.** A plugin that keeps per-turn state (Crew) has to infer from event order, the queue and retry ancestry that a restart-cut turn will be continued. Two residual races remain, and each costs at most one lead notice. In one, Crew is offline for an older failure when a restart cuts a newer turn. In the other, Crew is still handling a refused continuation when a later turn is cut. Fix: put the restart continuation on the failure or interruption event, or on the SDK thread response, then delete Crew's inference. It needs a plugin SDK change, which the queue-admission change (`fix/queue-admission-0501`) could not make.
- **A restart retry replay loses its input groups.** When the provider never accepted the original request, the native restart retry replays the original input blocks in order, separators included, but drops `inputGroups`. A restart retry is a single queued row, and the queue drain sends `inputGroups` only when it claims more than one row (`apps/server/src/services/threads/queued-messages.ts`, `inputGroups.length > 1`). This is stock 0.50.1 behavior, observed in the Q2 loopback acceptance run. Fix: store the original groups on the retry row and replay them.

## Queue admission

- **A restart hold that lands during a pending hook can meet a regrouped queue.** An automatic attempt claims a group that holds a restart retry. A plugin then sets the restart hold while the attempt's dispatch hook is still pending, a user regroups the rows, and the hook fails. After the claim is released, the failure recorder decides from the rebuilt group whether to record a failure on the attempted row (`apps/server/src/services/threads/queue-drain-failure.ts`). If the regroup moved the restart retry out of that row's group, the attempted row can be marked failed although a held restart retry was part of the attempt. All three events must coincide, and Send now or a retry recovers the row.
