import { z } from "zod";
import { queuedMessageWaitReasonSchema } from "./queued-message.js";

export const RESTART_RESUME_METADATA_KEY = "experimental_restartResume";

export const restartResumeMetadataSchema = z.object({
  hold: z.boolean(),
  reason: queuedMessageWaitReasonSchema.optional(),
  receiptBacked: z.boolean().optional(),
});
