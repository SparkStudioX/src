import type { InputValues, PythonUiSnapshot, RuntimeParameters } from "./types";

export interface TagActionReview {
  token: string; commandId: string; name: string; currentValue: string | number | boolean;
  requestedValue: string | number | boolean; confirmation: string; expiresAt: string;
}
export interface TagActionReceipt {
  correlationId: string; status: "confirmed" | "notConfirmed" | "rejected" | "uncertain";
  message: string; requestedValue: string | number | boolean; observedValue?: string | number | boolean | null;
}
export type TagActionApi = <T>(path: string, method: string, body: unknown, signal?: AbortSignal) => Promise<T>;
export interface TagActionIdentity {
  parameters: RuntimeParameters; publishedAt: string;
  inputs?: InputValues; ui?: PythonUiSnapshot;
  instanceId?: string; rowId?: string; instancePath?: unknown; bindingInputs?: unknown; bindingState?: unknown; popupOrigin?: unknown;
}

/** The browser supplies scoped input/UI context. The saved tag and value source remain authoritative. */
export async function runTagValueAction(request: TagActionApi, route: string, identity: TagActionIdentity, options: {
  signal: AbortSignal; isCurrent: () => boolean; confirm: (review: TagActionReview) => Promise<boolean>;
}): Promise<TagActionReceipt | null> {
  const current = () => {
    options.signal.throwIfAborted();
    if (!options.isCurrent()) throw new Error("This application context changed. Activate the button again in its current screen.");
  };
  current();
  const review = await request<TagActionReview>(route + "/review", "POST", identity, options.signal);
  current();
  if (!review || typeof review.token !== "string" || !review.token || typeof review.confirmation !== "string"
    || !Number.isFinite(Date.parse(review.expiresAt))) throw new Error("The gateway returned an invalid tag action review.");
  if (review.confirmation && !await options.confirm(review)) return null;
  current();
  if (Date.parse(review.expiresAt) <= Date.now()) throw new Error("This tag action review expired. Activate the button again.");
  try {
    const result = await request<TagActionReceipt>(route + "/execute", "POST", { token: review.token, confirmed: true }, options.signal);
    current();
    if (!result || !["confirmed", "notConfirmed", "rejected", "uncertain"].includes(result.status) || typeof result.message !== "string")
      throw new Error("The gateway returned an invalid write receipt.");
    return result;
  } catch (error) {
    // Once dispatch starts, loss of the response cannot prove that the target stayed unchanged.
    options.signal.throwIfAborted();
    throw new Error("No tag write receipt was received. Check the tag's current value before trying again.", { cause: error });
  }
}
