/** Worker boundary: one schema validates complete results and preserves classified facts. */
import { Type, type Static } from "typebox";
import { errorDescriptorSchema } from "../core/report-schema.ts";
export const workerMessageSchema = Type.Union([
  Type.Object(
    {
      status: Type.Literal("success"),
      result: Type.Object({ text: Type.String(), count: Type.Integer({ minimum: 0 }) }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Literal("failure"),
      error: errorDescriptorSchema,
      cause: Type.Optional(Type.Object({ name: Type.String(), message: Type.String() })),
    },
    { additionalProperties: false },
  ),
]);
export type WorkerMessage = Static<typeof workerMessageSchema>;
