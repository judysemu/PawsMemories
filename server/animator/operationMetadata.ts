import { z } from "zod";

const AnimatorOperationSchema = z.object({
  version: z.literal(1),
  kind: z.literal("animator-voiceover"),
  providerOperationName: z.string().regex(/^heygen:[^\s]+$/),
  recordingId: z.string().uuid(),
});
export type AnimatorOperationMetadata = z.infer<typeof AnimatorOperationSchema>;
const PREFIX = "heygen:animator-v1:";

export function encodeAnimatorOperationMetadata(input: Omit<AnimatorOperationMetadata, "version" | "kind">): string {
  const value = AnimatorOperationSchema.parse({ version: 1, kind: "animator-voiceover", ...input });
  return `${PREFIX}${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
}

export function decodeAnimatorOperationMetadata(operationName: string | null | undefined): AnimatorOperationMetadata | null {
  if (!operationName?.startsWith(PREFIX)) return null;
  try { return AnimatorOperationSchema.parse(JSON.parse(Buffer.from(operationName.slice(PREFIX.length), "base64url").toString("utf8"))); }
  catch { return null; }
}
